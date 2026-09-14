package expo.modules.upnpcast

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** What the renderer is told about the track it is about to play. */
class TrackInfo(
  @Field val mime: String = "audio/mpeg",
  @Field val title: String = "",
  @Field val artist: String? = null,
  @Field val albumArtist: String? = null,
  @Field val album: String? = null,
  @Field val artworkUrl: String? = null,
  @Field val durationSec: Double? = null
) : Record

/**
 * Expo bridge to UPnPCast (DLNA/UPnP). Finds renderers on the local network and
 * drives playback over AVTransport. UPnP has no reliable way of pushing events,
 * so state and progress are polled once a second for as long as there is a
 * session and sent to JS as a "state" event.
 */
class UpnpCastModule : Module() {
  private enum class NextUriCapability { UNKNOWN, SUPPORTED, UNSUPPORTED }

  private data class QueueRequest(
    val tracks: List<Track>,
    val currentIndex: Int,
    val positionMs: Long,
    val playMode: String,
    val autoplay: Boolean,
  )

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  @Volatile private var pollJob: Job? = null
  private val transportMutex = Mutex()

  private val known = ConcurrentHashMap<String, RendererSession>()
  @Volatile private var session: RendererSession? = null

  // Guarded by transportMutex. Sonos keeps using its renderer-side queue; this
  // state is authoritative only for ordinary AVTransport renderers.
  private var nativeQueue: List<Track> = emptyList()
  private var nativeQueueIndex = -1
  private var nativePlayMode = "NORMAL"
  private var nativeQueueManaged = false
  private var lastPlaybackState = ""
  private var lastNonzeroPositionMs = 0L
  private var lastNonzeroDurationMs = 0L
  private var observedPlaying = false
  private var stoppedByUs = false
  private var transitionInProgress = false
  private var stoppedPolls = 0
  private var stagedNextIndex: Int? = null
  private var stagedNextUrl: String? = null
  private var nextUriCapability = NextUriCapability.UNKNOWN

  private fun parseQueueRequest(payloadJson: String): QueueRequest {
    val payload = JSONObject(payloadJson)
    val tracksJson = payload.getJSONArray("tracks")
    val tracks = mutableListOf<Track>()
    for (i in 0 until tracksJson.length()) {
      val item = tracksJson.getJSONObject(i)
      tracks.add(
        Track(
          url = item.getString("url"),
          mime = item.optString("mime", "audio/mpeg"),
          title = item.optString("title", ""),
          artist = item.optString("artist").takeIf { it.isNotBlank() },
          albumArtist = item.optString("albumArtist").takeIf { it.isNotBlank() },
          album = item.optString("album").takeIf { it.isNotBlank() },
          artworkUrl = item.optString("artworkUrl").takeIf { it.isNotBlank() },
          durationSeconds = item.optInt("durationSec", 0)
        )
      )
    }
    return QueueRequest(
      tracks = tracks,
      currentIndex = payload.optInt("currentIndex", 0),
      positionMs = payload.optDouble("positionMs", 0.0).toLong(),
      playMode = payload.optString("playMode", "NORMAL"),
      autoplay = payload.optBoolean("autoplay", false),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("UpnpCast")

    Events("state")

    OnDestroy {
      pollJob?.cancel()
      scope.cancel()
    }

    /**
     * Searches the network for renderers, resolving with the list once the
     * timeout is up.
     *
     * A search has to go out to the whole network, so everything on it answers,
     * and almost nothing in a house can play a note. The router is the usual
     * one: it speaks UPnP to open ports, and it ended up in a list of speakers,
     * which is all anyone without one would find there. Devices that answer
     * that they have no AVTransport are dropped; the ones that answer nothing
     * still show, since not having been able to ask is not a no.
     */
    AsyncFunction("search") { timeoutMs: Double, promise: Promise ->
      scope.launch {
        val found = Ssdp.discover(timeoutMs.toLong())
        val devices = found.map { (location, address) ->
          async {
            val description = Soap.fetch(location)?.let { DeviceDescription.parse(it, location) }
            if (description == null || !description.isRenderer) return@async null
            val sonos = SonosTopology.describe(description)
            val id = (description.udn?.removePrefix("uuid:")?.trim()?.takeIf(String::isNotEmpty)
              ?.let { if (description.isSonos) it.uppercase() else it }) ?: address
            known[id] = RendererSession(id, address, location, description)
            mapOf(
              "id" to id,
              "name" to (sonos?.name ?: description.displayName() ?: address),
              "address" to address,
              "isTV" to description.isTv,
              "isSonos" to description.isSonos,
              "groupId" to sonos?.groupId,
              "coordinatorId" to sonos?.coordinatorId,
            )
          }
        }.awaitAll().filterNotNull()
        promise.resolve(devices)
      }
    }

    AsyncFunction("connect") { deviceId: String, promise: Promise ->
      val target = known[deviceId]
      if (target == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch {
        transportMutex.withLock {
          session = target
          clearNativeQueueState()
        }
        startPolling()
        promise.resolve(true)
      }
    }

    AsyncFunction("join") { deviceId: String, targetDeviceId: String, promise: Promise ->
      val device = known[deviceId]
      val target = known[targetDeviceId]
      if (device == null || target == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch { promise.resolve(device.join(target)) }
    }

    AsyncFunction("ungroup") { deviceId: String, promise: Promise ->
      val device = known[deviceId]
      if (device == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch { promise.resolve(device.ungroup()) }
    }

    AsyncFunction("load") { url: String, track: TrackInfo, autoplay: Boolean, promise: Promise ->
      val current = session
      if (current == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch {
        val ok = transportMutex.withLock {
          if (session !== current) return@withLock false
          clearNativeQueueState()
          stoppedByUs = !autoplay
          current.load(
            Track(
              url = url,
              mime = track.mime,
              title = track.title,
              artist = track.artist,
              albumArtist = track.albumArtist,
              album = track.album,
              artworkUrl = track.artworkUrl,
              durationSeconds = (track.durationSec ?: 0.0).toInt()
            )
          )
        }
        promise.resolve(ok)
      }
    }

    AsyncFunction("loadQueue") { payloadJson: String, promise: Promise ->
      val current = session
      if (current == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch {
        try {
          val request = parseQueueRequest(payloadJson)
          val ok = transportMutex.withLock {
            if (session !== current) return@withLock false
            if (!current.isSonos) {
              installNativeQueue(request.tracks, request.currentIndex, request.playMode)
              stoppedByUs = !request.autoplay
              transitionInProgress = true
            }
            val loaded = current.loadQueue(
              tracks = request.tracks,
              currentIndex = request.currentIndex,
              autoplay = request.autoplay,
              positionMs = request.positionMs,
              playMode = request.playMode
            )
            if (!current.isSonos) {
              transitionInProgress = false
              if (loaded) {
                resetTrackObservation(request.positionMs)
                Log.d(Soap.TAG, "Native queue loaded count=${nativeQueue.size} currentIndex=$nativeQueueIndex title=${trackLabel(nativeQueueIndex)}")
                stageNextLocked(current)
              } else {
                Log.w(Soap.TAG, "Native queue load failed currentIndex=$nativeQueueIndex")
              }
            }
            loaded
          }
          promise.resolve(ok)
        } catch (e: Exception) {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("syncQueue") { payloadJson: String, promise: Promise ->
      val current = session
      if (current == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      scope.launch {
        try {
          val request = parseQueueRequest(payloadJson)
          val ok = transportMutex.withLock {
            if (session !== current) return@withLock false
            if (current.isSonos) {
              current.syncQueue(
                tracks = request.tracks,
                currentIndex = request.currentIndex,
                positionMs = request.positionMs,
                playMode = request.playMode
              )
            } else {
              syncNativeQueueLocked(current, request)
            }
          }
          promise.resolve(ok)
        } catch (e: Exception) {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("play") { promise: Promise ->
      scope.launch { promise.resolve(transportMutex.withLock {
        stoppedByUs = false
        session?.play() ?: false
      }) }
    }

    AsyncFunction("pause") { promise: Promise ->
      scope.launch { promise.resolve(transportMutex.withLock {
        stoppedByUs = true
        observedPlaying = false
        session?.pause() ?: false
      }) }
    }

    AsyncFunction("seek") { positionMs: Double, promise: Promise ->
      scope.launch { promise.resolve(transportMutex.withLock { session?.seek(positionMs.toLong()) ?: false }) }
    }

    AsyncFunction("setVolume") { volume: Int, promise: Promise ->
      scope.launch { promise.resolve(session?.setVolume(volume) ?: false) }
    }

    AsyncFunction("setPlayMode") { playMode: String, promise: Promise ->
      scope.launch { promise.resolve(transportMutex.withLock {
        nativePlayMode = playMode
        stagedNextIndex = null
        stagedNextUrl = null
        val current = session ?: return@withLock false
        val accepted = if (current.isSonos) current.setPlayMode(playMode) else true
        if (!current.isSonos) stageNextLocked(current, clearIfNone = true)
        accepted
      }) }
    }

    AsyncFunction("setCrossfadeMode") { enabled: Boolean, promise: Promise ->
      scope.launch { promise.resolve(session?.setCrossfadeMode(enabled) ?: false) }
    }

    AsyncFunction("setSleepTimer") { durationSec: Double, promise: Promise ->
      val seconds = durationSec.toInt().coerceAtLeast(0)
      scope.launch { promise.resolve(session?.setSleepTimer(seconds) ?: false) }
    }

    AsyncFunction("disconnect") { promise: Promise ->
      val current = session
      pollJob?.cancel()
      pollJob = null
      session = null
      scope.launch {
        transportMutex.withLock {
          stoppedByUs = true
          observedPlaying = false
          clearNativeQueueState()
          current?.stop()
        }
        promise.resolve(true)
      }
    }
  }

  private fun startPolling() {
    pollJob?.cancel()
    pollJob = scope.launch {
      while (isActive) {
        val current = session
        val state = if (current == null) null else transportMutex.withLock {
          if (session !== current) return@withLock null
          val polled = current.state()
          if (polled != null && !current.isSonos) handleGenericStateLocked(current, polled)
          polled
        }
        if (state != null) {
          val currentTrackNumber = state.trackNumber
          val playMode = state.playMode
          val playbackState = when {
            state.playbackState.equals("PLAYING", ignoreCase = true) -> "PLAYING"
            state.playbackState.equals("TRANSITIONING", ignoreCase = true) -> "BUFFERING"
            state.playbackState.startsWith("PAUSED", ignoreCase = true) -> "PAUSED"
            state.playbackState.equals("NO_MEDIA_PRESENT", ignoreCase = true) -> "IDLE"
            state.playbackState.equals("STOPPED", ignoreCase = true) -> "STOPPED"
            else -> state.playbackState
          }
          sendEvent(
            "state",
            mapOf(
              "playbackState" to playbackState,
              "positionMs" to state.positionMs.toDouble(),
              "durationMs" to state.durationMs.toDouble(),
              "trackNumber" to (currentTrackNumber?.toDouble() ?: 0.0),
              "playMode" to (playMode ?: ""),
              "nativeQueueManaged" to (nativeQueueManaged && current?.isSonos == false),
              "queueIndex" to if (nativeQueueManaged && current?.isSonos == false) nativeQueueIndex.toDouble() else -1.0,
            ),
          )
        }
        delay(1000)
      }
    }
  }

  private fun installNativeQueue(tracks: List<Track>, requestedIndex: Int, playMode: String) {
    nativeQueue = tracks
    nativeQueueIndex = if (tracks.isEmpty()) -1 else requestedIndex.coerceIn(0, tracks.lastIndex)
    nativePlayMode = playMode
    nativeQueueManaged = tracks.isNotEmpty()
    stagedNextIndex = null
    stagedNextUrl = null
    stoppedPolls = 0
  }

  private fun clearNativeQueueState() {
    nativeQueue = emptyList()
    nativeQueueIndex = -1
    nativePlayMode = "NORMAL"
    nativeQueueManaged = false
    lastPlaybackState = ""
    lastNonzeroPositionMs = 0
    lastNonzeroDurationMs = 0
    observedPlaying = false
    stoppedByUs = false
    transitionInProgress = false
    stoppedPolls = 0
    stagedNextIndex = null
    stagedNextUrl = null
    nextUriCapability = NextUriCapability.UNKNOWN
  }

  private fun resetTrackObservation(positionMs: Long = 0) {
    lastPlaybackState = ""
    lastNonzeroPositionMs = positionMs.coerceAtLeast(0)
    lastNonzeroDurationMs = 0
    observedPlaying = false
    stoppedPolls = 0
  }

  private fun nextQueueIndex(): Int? {
    if (!nativeQueueManaged) return null
    return GenericQueueProgression.nextIndex(nativeQueue.size, nativeQueueIndex, nativePlayMode)
  }

  private suspend fun stageNextLocked(current: RendererSession, clearIfNone: Boolean = false) {
    if (!nativeQueueManaged || nextUriCapability == NextUriCapability.UNSUPPORTED || transitionInProgress) return
    val nextIndex = nextQueueIndex()
    if (nextIndex == null) {
      if (clearIfNone && nextUriCapability == NextUriCapability.SUPPORTED) {
        when (current.clearNextUri()) {
          RendererSession.NextUriResult.ACCEPTED -> Log.d(Soap.TAG, "Cleared staged next URI at end of queue")
          RendererSession.NextUriResult.UNSUPPORTED -> nextUriCapability = NextUriCapability.UNSUPPORTED
          RendererSession.NextUriResult.FAILED -> Log.w(Soap.TAG, "Transient failure clearing staged next URI")
        }
      }
      return
    }
    val track = nativeQueue.getOrNull(nextIndex) ?: return
    if (stagedNextIndex == nextIndex && stagedNextUrl == track.url) return
    Log.d(Soap.TAG, "SetNextAVTransportURI attempt index=$nextIndex title=${track.title}")
    when (current.setNextUri(track)) {
      RendererSession.NextUriResult.ACCEPTED -> {
        nextUriCapability = NextUriCapability.SUPPORTED
        stagedNextIndex = nextIndex
        stagedNextUrl = track.url
        Log.d(Soap.TAG, "SetNextAVTransportURI accepted; next URI staged index=$nextIndex title=${track.title}")
      }
      RendererSession.NextUriResult.UNSUPPORTED -> {
        nextUriCapability = NextUriCapability.UNSUPPORTED
        stagedNextIndex = null
        stagedNextUrl = null
        Log.d(Soap.TAG, "SetNextAVTransportURI marked unsupported; native STOPPED fallback enabled")
      }
      RendererSession.NextUriResult.FAILED ->
        Log.w(Soap.TAG, "SetNextAVTransportURI transient failure index=$nextIndex; playback unchanged")
    }
  }

  private suspend fun syncNativeQueueLocked(current: RendererSession, request: QueueRequest): Boolean {
    if (request.tracks.isEmpty()) return false
    val oldCurrentUrl = nativeQueue.getOrNull(nativeQueueIndex)?.url
    nativeQueue = request.tracks
    nativeQueueIndex = oldCurrentUrl?.let { url -> request.tracks.indexOfFirst { it.url == url }.takeIf { it >= 0 } }
      ?: request.currentIndex.coerceIn(0, request.tracks.lastIndex)
    nativePlayMode = request.playMode
    nativeQueueManaged = true
    stagedNextIndex = null
    stagedNextUrl = null
    Log.d(Soap.TAG, "Native queue updated count=${nativeQueue.size} currentIndex=$nativeQueueIndex title=${trackLabel(nativeQueueIndex)}")
    stageNextLocked(current, clearIfNone = true)
    return true
  }

  private suspend fun handleGenericStateLocked(current: RendererSession, state: RendererSession.State) {
    if (!nativeQueueManaged) return
    val playback = state.playbackState.uppercase()
    val stagedIndex = stagedNextIndex
    val stagedTrack = stagedIndex?.let(nativeQueue::getOrNull)
    val uriIdentifiedHandoff = state.currentUri?.isNotBlank() == true && state.currentUri == stagedNextUrl
    val positionIdentifiedHandoff = stagedTrack != null && GenericQueueProgression.isStagedHandoff(
      playbackState = playback,
      positionMs = state.positionMs,
      durationMs = state.durationMs,
      previousPositionMs = lastNonzeroPositionMs,
      previousDurationMs = lastNonzeroDurationMs,
      stagedDurationMs = stagedTrack.durationSeconds * 1_000L,
    )
    val stagedStarted = stagedIndex != null && stagedIndex != nativeQueueIndex && (
      uriIdentifiedHandoff || positionIdentifiedHandoff ||
        (lastPlaybackState == "STOPPED" && playback == "PLAYING")
      )
    if (stagedStarted) {
      nativeQueueIndex = stagedIndex!!
      stagedNextIndex = null
      stagedNextUrl = null
      resetTrackObservation(state.positionMs)
      observedPlaying = playback == "PLAYING"
      stoppedByUs = false
      val evidence = when {
        uriIdentifiedHandoff -> "TrackURI"
        positionIdentifiedHandoff -> "position/duration reset"
        else -> "STOPPED -> PLAYING"
      }
      Log.d(Soap.TAG, "Renderer consumed staged URI ($evidence); native current index changed to $nativeQueueIndex title=${trackLabel(nativeQueueIndex)}")
      stageNextLocked(current)
    }

    // Repeat-one can keep the same URI and index, so TrackURI cannot identify
    // the handoff. A position wrap after the prior lap reached its end does.
    val repeatOneWrapped = stagedNextIndex == nativeQueueIndex &&
      nativePlayMode.equals("REPEAT_ONE", ignoreCase = true) &&
      playback == "PLAYING" && state.positionMs in 0..2_000L &&
      lastNonzeroPositionMs > 3_000L &&
      (lastNonzeroDurationMs <= 0 || lastNonzeroPositionMs >= lastNonzeroDurationMs - maxOf(5_000L, lastNonzeroDurationMs / 10))
    if (repeatOneWrapped) {
      stagedNextIndex = null
      stagedNextUrl = null
      resetTrackObservation(state.positionMs)
      observedPlaying = true
      Log.d(Soap.TAG, "Native repeat-one lap restarted index=$nativeQueueIndex title=${trackLabel(nativeQueueIndex)}")
      stageNextLocked(current)
    }

    if (state.positionMs > 0) lastNonzeroPositionMs = state.positionMs
    if (state.durationMs > 0) lastNonzeroDurationMs = state.durationMs
    if (playback == "PLAYING") {
      observedPlaying = true
      stoppedByUs = false
      stoppedPolls = 0
    }

    if (playback == "STOPPED" && lastPlaybackState != "STOPPED") {
      val windowMs = maxOf(5_000L, lastNonzeroDurationMs / 10)
      val nearEnd = lastNonzeroDurationMs <= 0 || lastNonzeroPositionMs >= lastNonzeroDurationMs - windowMs
      Log.d(Soap.TAG, "PLAYING -> STOPPED check index=$nativeQueueIndex positionMs=$lastNonzeroPositionMs durationMs=$lastNonzeroDurationMs observedPlaying=$observedPlaying stoppedByUs=$stoppedByUs nearEnd=$nearEnd")
    }

    if (playback == "STOPPED") stoppedPolls++ else if (playback != "TRANSITIONING") stoppedPolls = 0
    val naturalEnd = GenericQueueProgression.isNaturalEnd(
      observedPlaying,
      stoppedByUs,
      lastNonzeroPositionMs,
      lastNonzeroDurationMs,
    )
    val rendererHandoffGrace = nextUriCapability == NextUriCapability.SUPPORTED && stagedNextIndex != null && stoppedPolls < 2
    if (playback == "STOPPED" && naturalEnd && !rendererHandoffGrace) {
      if (transitionInProgress) {
        Log.d(Soap.TAG, "Duplicate transition suppressed index=$nativeQueueIndex")
      } else {
        if (advanceNativeQueueLocked(current)) {
          // Do not let the STOPPED snapshot which triggered our explicit load
          // masquerade as a renderer-side STOPPED -> PLAYING handoff next poll.
          lastPlaybackState = "TRANSITIONING"
          return
        }
      }
    }
    lastPlaybackState = playback
  }

  private suspend fun advanceNativeQueueLocked(current: RendererSession): Boolean {
    val nextIndex = nextQueueIndex()
    observedPlaying = false // makes repeated STOPPED polls idempotent
    stoppedPolls = 0
    if (nextIndex == null) {
      stagedNextIndex = null
      stagedNextUrl = null
      Log.d(Soap.TAG, "Native queue reached end at index=$nativeQueueIndex")
      return false
    }
    val track = nativeQueue[nextIndex]
    transitionInProgress = true
    stagedNextIndex = null
    stagedNextUrl = null
    Log.d(Soap.TAG, "Automatic native advancement $nativeQueueIndex -> $nextIndex title=${track.title}")
    val loaded = current.load(track)
    val played = loaded && current.play()
    transitionInProgress = false
    if (!played) {
      Log.w(Soap.TAG, "Automatic native advancement failed targetIndex=$nextIndex")
      return false
    }
    nativeQueueIndex = nextIndex
    stoppedByUs = false
    resetTrackObservation()
    Log.d(Soap.TAG, "Native current index changed to $nativeQueueIndex title=${track.title}")
    stageNextLocked(current)
    return true
  }

  private fun trackLabel(index: Int): String = nativeQueue.getOrNull(index)?.title.orEmpty()
}
