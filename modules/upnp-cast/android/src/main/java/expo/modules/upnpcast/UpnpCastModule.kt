package expo.modules.upnpcast

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
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
      session = target
      startPolling()
      promise.resolve(true)
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
            current.loadQueue(
              tracks = request.tracks,
              currentIndex = request.currentIndex,
              autoplay = request.autoplay,
              positionMs = request.positionMs,
              playMode = request.playMode
            )
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
            current.syncQueue(
              tracks = request.tracks,
              currentIndex = request.currentIndex,
              positionMs = request.positionMs,
              playMode = request.playMode
            )
          }
          promise.resolve(ok)
        } catch (e: Exception) {
          promise.resolve(false)
        }
      }
    }

    AsyncFunction("play") { promise: Promise ->
      scope.launch { promise.resolve(session?.play() ?: false) }
    }

    AsyncFunction("pause") { promise: Promise ->
      scope.launch { promise.resolve(session?.pause() ?: false) }
    }

    AsyncFunction("seek") { positionMs: Double, promise: Promise ->
      scope.launch { promise.resolve(session?.seek(positionMs.toLong()) ?: false) }
    }

    AsyncFunction("setVolume") { volume: Int, promise: Promise ->
      scope.launch { promise.resolve(session?.setVolume(volume) ?: false) }
    }

    AsyncFunction("setPlayMode") { playMode: String, promise: Promise ->
      scope.launch { promise.resolve(session?.setPlayMode(playMode) ?: false) }
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
        current?.stop()
        promise.resolve(true)
      }
    }
  }

  private fun startPolling() {
    pollJob?.cancel()
    pollJob = scope.launch {
      while (isActive) {
        val state = session?.state()
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
            ),
          )
        }
        delay(1000)
      }
    }
  }
}
