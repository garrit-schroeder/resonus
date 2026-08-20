package expo.modules.upnpcast

import android.util.Log

class RendererSession(
  val deviceId: String,
  val address: String,
  val location: String,
  initialDescription: DeviceDescription
) {
  @Volatile
  private var description: DeviceDescription = initialDescription

  @Volatile
  private var avTransport: String? = initialDescription.controlUrl(Services.AV_TRANSPORT)

  @Volatile
  private var queueControl: String? = initialDescription.controlUrl(Services.QUEUE)

  @Volatile
  private var lastQueueOwnerUid: String? = null

  @Volatile
  private var lastQueueId: Int? = null

  @Volatile
  private var lastQueueTrackUrls: List<String> = emptyList()

  @Volatile
  private var lastQueueUpdateId: Int = 0

  private val renderingControl: String? =
    initialDescription.controlUrl(Services.RENDERING_CONTROL)

  data class State(
    val playbackState: String,
    val positionMs: Long,
    val durationMs: Long,
    val trackNumber: Int?,
    val playMode: String?,
  )

  private data class TransportTarget(val controlUrl: String, val uid: String)

  suspend fun load(track: Track): Boolean {
    val target = resolveTransportTarget() ?: return false
    val accepted = setUri(target.controlUrl, track)

    if (!accepted) {
      return false
    }
    return true
  }

  suspend fun loadQueue(tracks: List<Track>, currentIndex: Int, autoplay: Boolean, positionMs: Long, playMode: String?): Boolean {
    val target = resolveTransportTarget() ?: return false
    val selectedIndex = currentIndex.coerceIn(0, tracks.lastIndex)

    // If the queue is already loaded and unchanged, skip the rebuild — just seek.
    val trackUrls = tracks.map { it.url }
    if (description.isSonos && lastQueueTrackUrls.isNotEmpty() && lastQueueTrackUrls == trackUrls) {
      if (!playMode.isNullOrBlank()) {
        Soap.call(
          target.controlUrl, Services.AV_TRANSPORT, "SetPlayMode",
          "<InstanceID>0</InstanceID><NewPlayMode>${Soap.escape(playMode)}</NewPlayMode>"
        )
      }
      if (!transport("Seek", "<InstanceID>0</InstanceID><Unit>TRACK_NR</Unit><Target>${selectedIndex + 1}</Target>")) return false
      if (positionMs > 0 && !seek(positionMs)) return false
      if (autoplay && !play()) return false
      return true
    }

    val accepted = replaceQueue(target.controlUrl, target.uid, tracks, currentIndex, autoplay, positionMs, playMode)

    if (!accepted) {
      return false
    }
    return true
  }

  suspend fun syncQueue(tracks: List<Track>, currentIndex: Int, positionMs: Long, playMode: String?): Boolean {
    val target = resolveTransportTarget() ?: return false
    val selectedIndex = currentIndex.coerceIn(0, tracks.lastIndex)
    val wasPlaying = if (description.isSonos) {
      val playback = state()?.playbackState?.uppercase()
      playback == "PLAYING" || playback == "TRANSITIONING"
    } else {
      false
    }

    val accepted = if (description.isSonos) {
      if (wasPlaying) {
        val currentTrackUrl = if (selectedIndex < tracks.size) tracks[selectedIndex].url else null
        val oldSelectedIndex = currentTrackUrl?.let { url -> lastQueueTrackUrls.indexOfFirst { it == url } } ?: -1
        val currentTrackMoved = oldSelectedIndex >= 0 && oldSelectedIndex != selectedIndex
        Log.d(Soap.TAG, "syncQueue: selectedIndex=$selectedIndex oldSelectedIndex=$oldSelectedIndex moved=$currentTrackMoved cacheSize=${lastQueueTrackUrls.size}")

        if (currentTrackMoved) {
          // Move only the current track's queue slot; playback is uninterrupted.
          val queueSvc = queueControl ?: refreshQueueControlUrl()
          val queueId = queueSvc?.let { resolveQueueId(it, target.uid) }
          var reordered = if (queueSvc != null && queueId != null) {
            // InsertBefore is relative to the queue BEFORE removal (Sonos spec).
            // For a forward move, removing the track shifts all positions above it
            // down by one, so the target position needs +2 instead of +1.
            val insertBefore = if (oldSelectedIndex < selectedIndex) selectedIndex + 2 else selectedIndex + 1
            Log.d(Soap.TAG, "ReorderTracks: StartingIndex=${oldSelectedIndex + 1} InsertBefore=$insertBefore updateId=$lastQueueUpdateId")
            val result = Soap.call(
              queueSvc, Services.QUEUE, "ReorderTracks",
              "<QueueID>$queueId</QueueID>" +
                "<StartingIndex>${oldSelectedIndex + 1}</StartingIndex>" +
                "<NumberOfTracks>1</NumberOfTracks>" +
                "<InsertBefore>$insertBefore</InsertBefore>" +
                "<UpdateID>$lastQueueUpdateId</UpdateID>"
            )
            Log.d(Soap.TAG, "ReorderTracks result: ok=${result.ok} body=${result.body?.take(200)}")
            if (result.ok) {
              lastQueueUpdateId = parseUpdateId(result.body, lastQueueUpdateId)
              val mutable = lastQueueTrackUrls.toMutableList()
              mutable.add(selectedIndex, mutable.removeAt(oldSelectedIndex))
              lastQueueTrackUrls = mutable
              true
            } else false
          } else false

          // After repositioning the current track, the head (0..selectedIndex-1)
          // may also be out of order (e.g. after turning off shuffle). Fix it with
          // the same backward-sweep ReorderTracks approach used for the tail.
          if (reordered && selectedIndex > 0 && queueSvc != null && queueId != null) {
            val targetHead = tracks.take(selectedIndex).map { it.url }
            val workingHead = lastQueueTrackUrls.take(selectedIndex).toMutableList()
            if (workingHead != targetHead) {
              for (i in targetHead.indices) {
                if (workingHead[i] == targetHead[i]) continue
                val sourceOffset = workingHead.subList(i, workingHead.size).indexOf(targetHead[i])
                if (sourceOffset < 0) { reordered = false; break }
                val absoluteSource = i + sourceOffset
                val hr = Soap.call(
                  queueSvc, Services.QUEUE, "ReorderTracks",
                  "<QueueID>$queueId</QueueID>" +
                    "<StartingIndex>${absoluteSource + 1}</StartingIndex>" +
                    "<NumberOfTracks>1</NumberOfTracks>" +
                    "<InsertBefore>${i + 1}</InsertBefore>" +
                    "<UpdateID>$lastQueueUpdateId</UpdateID>"
                )
                if (!hr.ok) { reordered = false; break }
                lastQueueUpdateId = parseUpdateId(hr.body, lastQueueUpdateId)
                workingHead.add(i, workingHead.removeAt(absoluteSource))
              }
              if (reordered) {
                val cache = lastQueueTrackUrls.toMutableList()
                for (i in workingHead.indices) cache[i] = workingHead[i]
                lastQueueTrackUrls = cache
              }
            }
          }

          if (reordered) {
            // Head and current track fixed; sync any remaining tail changes normally.
            syncQueueTailWhilePlaying(
              control = target.controlUrl,
              queueOwnerUid = target.uid,
              tracks = tracks,
              selectedIndex = selectedIndex,
              playMode = playMode,
            )
          } else {
            Log.d(Soap.TAG, "ReorderTracks failed or unavailable; falling back to full rebuild")
            // ReorderTracks unavailable; rebuild with seek as fallback.
            val livePositionMs = state()?.positionMs ?: positionMs
            replaceQueueViaQueueService(
              control = target.controlUrl,
              queueOwnerUid = target.uid,
              tracks = tracks,
              selectedIndex = selectedIndex,
              autoplay = true,
              positionMs = livePositionMs,
              playMode = playMode,
              applyTransport = true,
            )
          }
        } else {
          syncQueueTailWhilePlaying(
            control = target.controlUrl,
            queueOwnerUid = target.uid,
            tracks = tracks,
            selectedIndex = selectedIndex,
            playMode = playMode,
          )
        }
      } else {
        replaceQueueViaQueueService(
          control = target.controlUrl,
          queueOwnerUid = target.uid,
          tracks = tracks,
          selectedIndex = selectedIndex,
          autoplay = false,
          positionMs = positionMs,
          playMode = playMode,
          applyTransport = false,
        )
      }
    } else {
      // Non-Sonos renderers have no queue-service path.
      loadQueue(tracks, currentIndex, autoplay = false, positionMs = positionMs, playMode = playMode)
    }

    if (!accepted) {
      // Only drop the cached transport URL when the device was not playing.
      // While playing, a rejected tail-sync (e.g. unsupported operation or the
      // current track moved) is not a connection error; the URL is still valid
      // and clearing it would break the next play/pause/seek command.
      if (!wasPlaying) avTransport = null
      return false
    }

    return true
  }

  private suspend fun setUri(control: String, track: Track): Boolean {
    val escapedMetadata = Soap.escape(Didl.forTrack(track))
    Log.d(
      Soap.TAG,
      "SetAVTransportURI with metadata title=${track.title} artist=${track.artist} album=${track.album} artworkUrl=${track.artworkUrl} metadataBytes=${escapedMetadata.length}"
    )
    val result = Soap.call(
      control,
      Services.AV_TRANSPORT,
      "SetAVTransportURI",
      "<InstanceID>0</InstanceID>" +
        "<CurrentURI>${Soap.escape(track.url)}</CurrentURI>" +
        "<CurrentURIMetaData>$escapedMetadata</CurrentURIMetaData>"
    )
    return result.ok
  }

  private suspend fun enqueueTrack(control: String, track: Track): Boolean {
    val result = Soap.call(
      control,
      Services.AV_TRANSPORT,
      "AddURIToQueue",
      "<InstanceID>0</InstanceID>" +
        "<EnqueuedURI>${Soap.escape(track.url)}</EnqueuedURI>" +
        "<EnqueuedURIMetaData>${Soap.escape(Didl.forTrack(track))}</EnqueuedURIMetaData>" +
        "<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>" +
        "<EnqueueAsNext>0</EnqueueAsNext>"
    )
    if (!result.ok) return false
    val firstTrack = Soap.argument(result.body, "FirstTrackNumberEnqueued")
    val numTracks = Soap.argument(result.body, "NumTracksAdded")
    Log.d(
      Soap.TAG,
      "AddURIToQueue accepted title=${track.title} firstTrack=$firstTrack numTracks=$numTracks"
    )
    return true
  }

  private suspend fun replaceQueue(control: String, queueOwnerUid: String, tracks: List<Track>, currentIndex: Int, autoplay: Boolean, positionMs: Long, playMode: String?): Boolean {
    if (tracks.isEmpty()) return false
    val selectedIndex = currentIndex.coerceIn(0, tracks.lastIndex)

    if (description.isSonos) {
      return replaceQueueViaQueueService(control, queueOwnerUid, tracks, selectedIndex, autoplay, positionMs, playMode)
    }

    if (!transport("RemoveAllTracksFromQueue", INSTANCE)) return false
    for (track in tracks) {
      val accepted = enqueueTrack(control, track)
      if (!accepted) return false
    }

    val queueUri = "x-rincon-queue:$queueOwnerUid#0"
    val queueMeta = Soap.escape(Didl.forQueueContainer(queueUri, tracks.size))
    if (!Soap.call(
        control,
        Services.AV_TRANSPORT,
        "SetAVTransportURI",
        "<InstanceID>0</InstanceID>" +
          "<CurrentURI>${Soap.escape(queueUri)}</CurrentURI>" +
          "<CurrentURIMetaData>$queueMeta</CurrentURIMetaData>"
      ).ok
    ) {
      return false
    }

    if (!playMode.isNullOrBlank()) {
      if (!Soap.call(
          control,
          Services.AV_TRANSPORT,
          "SetPlayMode",
          "<InstanceID>0</InstanceID><NewPlayMode>${Soap.escape(playMode)}</NewPlayMode>"
        ).ok
      ) {
        return false
      }
    }

    if (!transport("Seek", "<InstanceID>0</InstanceID><Unit>TRACK_NR</Unit><Target>${selectedIndex + 1}</Target>")) {
      return false
    }

    if (positionMs > 0) {
      if (!seek(positionMs)) return false
    }

    if (autoplay) {
      if (!play()) return false
    }
    return true
  }

  private suspend fun replaceQueueViaQueueService(
    control: String,
    queueOwnerUid: String,
    tracks: List<Track>,
    selectedIndex: Int,
    autoplay: Boolean,
    positionMs: Long,
    playMode: String?,
    applyTransport: Boolean = true,
  ): Boolean {
    val queueSvc = queueControl ?: refreshQueueControlUrl() ?: return false
    val queueId = resolveQueueId(queueSvc, queueOwnerUid) ?: return false

    if (!Soap.call(
        queueSvc,
        Services.QUEUE,
        "RemoveAllTracks",
        "<QueueID>$queueId</QueueID><UpdateID>0</UpdateID>"
      ).ok
    ) {
      return false
    }

    var updateId = 0
    for (track in tracks) {
      val result = Soap.call(
        queueSvc,
        Services.QUEUE,
        "AddURI",
        "<QueueID>$queueId</QueueID>" +
          "<UpdateID>$updateId</UpdateID>" +
          "<EnqueuedURI>${Soap.escape(track.url)}</EnqueuedURI>" +
          "<EnqueuedURIMetaData>${Soap.escape(Didl.forTrack(track))}</EnqueuedURIMetaData>" +
          "<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>" +
          "<EnqueueAsNext>0</EnqueueAsNext>"
      )
      if (!result.ok) return false
      updateId = parseUpdateId(result.body, updateId)
    }

    rememberQueueState(queueOwnerUid, queueId, tracks, updateId)

    if (!playMode.isNullOrBlank()) {
      if (!Soap.call(
          control,
          Services.AV_TRANSPORT,
          "SetPlayMode",
          "<InstanceID>0</InstanceID><NewPlayMode>${Soap.escape(playMode)}</NewPlayMode>"
        ).ok
      ) {
        return false
      }
    }

    if (!applyTransport) {
      return true
    }

    val queueUri = "x-rincon-queue:$queueOwnerUid#$queueId"
    val queueMeta = Soap.escape(Didl.forQueueContainer(queueUri, tracks.size))
    if (!Soap.call(
        control,
        Services.AV_TRANSPORT,
        "SetAVTransportURI",
        "<InstanceID>0</InstanceID>" +
          "<CurrentURI>${Soap.escape(queueUri)}</CurrentURI>" +
          "<CurrentURIMetaData>$queueMeta</CurrentURIMetaData>"
      ).ok
    ) {
      return false
    }

    if (!transport("Seek", "<InstanceID>0</InstanceID><Unit>TRACK_NR</Unit><Target>${selectedIndex + 1}</Target>")) {
      return false
    }

    if (positionMs > 0) {
      if (!seek(positionMs)) return false
    }

    if (autoplay) {
      if (!play()) return false
    }
    return true
  }

  private suspend fun syncQueueTailWhilePlaying(
    control: String,
    queueOwnerUid: String,
    tracks: List<Track>,
    selectedIndex: Int,
    playMode: String?,
  ): Boolean {
    val queueSvc = queueControl ?: refreshQueueControlUrl() ?: return false
    val queueId = resolveQueueId(queueSvc, queueOwnerUid) ?: return false

    val previousUrls = lastQueueTrackUrls
    if (lastQueueOwnerUid != queueOwnerUid || lastQueueId != queueId || previousUrls.isEmpty()) {
      return false
    }

    if (selectedIndex < 0 || selectedIndex >= previousUrls.size || selectedIndex >= tracks.size) {
      return false
    }

    val currentUrl = tracks[selectedIndex].url
    if (previousUrls[selectedIndex] != currentUrl) {
      // Current track moved/replaced: avoid disruptive rewrite while playing.
      return false
    }

    val tailStart = selectedIndex + 1
    val previousTail = previousUrls.drop(tailStart)
    val targetTail = tracks.drop(tailStart)
    val targetTailUrls = targetTail.map { it.url }
    var updateId = lastQueueUpdateId

    when {
      previousTail == targetTailUrls -> {
        // No structural change in the tail.
      }
      targetTailUrls.size > previousTail.size && previousTail == targetTailUrls.take(previousTail.size) -> {
        // Pure append after current tail.
        for (track in targetTail.drop(previousTail.size)) {
          val result = Soap.call(
            queueSvc,
            Services.QUEUE,
            "AddURI",
            "<QueueID>$queueId</QueueID>" +
              "<UpdateID>$updateId</UpdateID>" +
              "<EnqueuedURI>${Soap.escape(track.url)}</EnqueuedURI>" +
              "<EnqueuedURIMetaData>${Soap.escape(Didl.forTrack(track))}</EnqueuedURIMetaData>" +
              "<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>" +
              "<EnqueueAsNext>0</EnqueueAsNext>"
          )
          if (!result.ok) return false
          updateId = parseUpdateId(result.body, updateId)
        }
      }
      targetTailUrls.size > previousTail.size -> {
        // Insertion-only change (for example "play next"): previous tail stays in
        // order, with additional tracks inserted somewhere in between.
        val insertedTracks = mutableListOf<Track>()
        var prevPos = 0
        var possibleInsertionOnly = true
        for (track in targetTail) {
          val url = track.url
          if (prevPos < previousTail.size && previousTail[prevPos] == url) {
            prevPos++
          } else {
            insertedTracks.add(track)
          }
        }
        if (prevPos != previousTail.size) {
          possibleInsertionOnly = false
        }
        if (!possibleInsertionOnly) {
          // KISS: unsupported mixed operation while playing.
          return false
        }

        for (track in insertedTracks) {
          val result = Soap.call(
            queueSvc,
            Services.QUEUE,
            "AddURI",
            "<QueueID>$queueId</QueueID>" +
              "<UpdateID>$updateId</UpdateID>" +
              "<EnqueuedURI>${Soap.escape(track.url)}</EnqueuedURI>" +
              "<EnqueuedURIMetaData>${Soap.escape(Didl.forTrack(track))}</EnqueuedURIMetaData>" +
              "<DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued>" +
              "<EnqueueAsNext>0</EnqueueAsNext>"
          )
          if (!result.ok) return false
          updateId = parseUpdateId(result.body, updateId)
        }

        // Reorder appended inserts into their target positions.
        val working = (previousTail + insertedTracks.map { it.url }).toMutableList()
        for (targetOffset in targetTailUrls.indices) {
          if (working[targetOffset] == targetTailUrls[targetOffset]) continue
          val sourceOffset = working.subList(targetOffset, working.size).indexOf(targetTailUrls[targetOffset])
          if (sourceOffset < 0) return false
          val absoluteSourceIndex = tailStart + targetOffset + sourceOffset
          val absoluteTargetIndex = tailStart + targetOffset
          val reorder = Soap.call(
            queueSvc,
            Services.QUEUE,
            "ReorderTracks",
            "<QueueID>$queueId</QueueID>" +
              "<StartingIndex>${absoluteSourceIndex + 1}</StartingIndex>" +
              "<NumberOfTracks>1</NumberOfTracks>" +
              "<InsertBefore>${absoluteTargetIndex + 1}</InsertBefore>" +
              "<UpdateID>$updateId</UpdateID>"
          )
          if (!reorder.ok) return false
          updateId = parseUpdateId(reorder.body, updateId)
          val moved = working.removeAt(targetOffset + sourceOffset)
          working.add(targetOffset, moved)
        }
      }
      targetTailUrls.size < previousTail.size && targetTailUrls == previousTail.take(targetTailUrls.size) -> {
        // Pure trim at the end.
        val removeCount = previousTail.size - targetTailUrls.size
        val removeStart = tailStart + targetTailUrls.size
        val remove = Soap.call(
          queueSvc,
          Services.QUEUE,
          "RemoveTrackRange",
          "<QueueID>$queueId</QueueID>" +
            "<UpdateID>$updateId</UpdateID>" +
            "<StartingIndex>${removeStart + 1}</StartingIndex>" +
            "<NumberOfTracks>$removeCount</NumberOfTracks>"
        )
        if (!remove.ok) return false
        updateId = parseUpdateId(remove.body, updateId)
      }
      targetTailUrls.size < previousTail.size -> {
        // Deletion-only change inside the tail: target tail must be a subsequence
        // of the previous tail with stable order.
        val removeOffsets = mutableListOf<Int>()
        var prevPos = 0
        var targetPos = 0
        while (prevPos < previousTail.size) {
          val prevUrl = previousTail[prevPos]
          val targetUrl = targetTailUrls.getOrNull(targetPos)
          if (targetUrl != null && prevUrl == targetUrl) {
            targetPos++
          } else {
            removeOffsets.add(prevPos)
          }
          prevPos++
        }
        if (targetPos != targetTailUrls.size) {
          // KISS: unsupported mixed operation while playing.
          return false
        }

        // Remove from back to front, collapsing adjacent indices into one call.
        var i = removeOffsets.size - 1
        while (i >= 0) {
          val rangeEnd = removeOffsets[i]
          var rangeStart = rangeEnd
          while (i > 0 && removeOffsets[i - 1] == rangeStart - 1) {
            i--
            rangeStart = removeOffsets[i]
          }
          val absoluteStart = tailStart + rangeStart
          val removeCount = rangeEnd - rangeStart + 1
          val remove = Soap.call(
            queueSvc,
            Services.QUEUE,
            "RemoveTrackRange",
            "<QueueID>$queueId</QueueID>" +
              "<UpdateID>$updateId</UpdateID>" +
              "<StartingIndex>${absoluteStart + 1}</StartingIndex>" +
              "<NumberOfTracks>$removeCount</NumberOfTracks>"
          )
          if (!remove.ok) return false
          updateId = parseUpdateId(remove.body, updateId)
          i--
        }
      }
      targetTailUrls.size == previousTail.size &&
        targetTailUrls.groupingBy { it }.eachCount() == previousTail.groupingBy { it }.eachCount() -> {
        // Reorder in place using ReorderTracks (InsertBefore semantics).
        val working = previousTail.toMutableList()
        for (targetOffset in targetTailUrls.indices) {
          if (working[targetOffset] == targetTailUrls[targetOffset]) continue
          val sourceOffset = working.subList(targetOffset, working.size).indexOf(targetTailUrls[targetOffset])
          if (sourceOffset < 0) return false
          val absoluteSourceIndex = tailStart + targetOffset + sourceOffset
          val absoluteTargetIndex = tailStart + targetOffset
          val reorder = Soap.call(
            queueSvc,
            Services.QUEUE,
            "ReorderTracks",
            "<QueueID>$queueId</QueueID>" +
              "<StartingIndex>${absoluteSourceIndex + 1}</StartingIndex>" +
              "<NumberOfTracks>1</NumberOfTracks>" +
              "<InsertBefore>${absoluteTargetIndex + 1}</InsertBefore>" +
              "<UpdateID>$updateId</UpdateID>"
          )
          if (!reorder.ok) return false
          updateId = parseUpdateId(reorder.body, updateId)
          val moved = working.removeAt(targetOffset + sourceOffset)
          working.add(targetOffset, moved)
        }
      }
      else -> {
        // KISS: no mixed-operation fallback while playing.
        // If this is not a pure append, pure trim, or pure reorder, caller must retry in a safer state.
        return false
      }
    }

    rememberQueueState(queueOwnerUid, queueId, tracks, updateId)

    if (!playMode.isNullOrBlank()) {
      if (!Soap.call(
          control,
          Services.AV_TRANSPORT,
          "SetPlayMode",
          "<InstanceID>0</InstanceID><NewPlayMode>${Soap.escape(playMode)}</NewPlayMode>"
        ).ok
      ) {
        return false
      }
    }

    return true
  }

  private fun rememberQueueState(queueOwnerUid: String, queueId: Int, tracks: List<Track>, updateId: Int) {
    lastQueueOwnerUid = queueOwnerUid
    lastQueueId = queueId
    lastQueueTrackUrls = tracks.map { it.url }
    lastQueueUpdateId = updateId
  }

  private suspend fun resolveQueueId(queueSvc: String, queueOwnerUid: String): Int? {
    val attach = Soap.call(
      queueSvc,
      Services.QUEUE,
      "AttachQueue",
      "<QueueOwnerID>${Soap.escape(queueOwnerUid)}</QueueOwnerID>"
    )
    val attachedQueueId = if (attach.ok) {
      Soap.argument(attach.body, "QueueID")?.toIntOrNull()
    } else {
      null
    }
    if (attachedQueueId != null) return attachedQueueId
    val create = Soap.call(
      queueSvc,
      Services.QUEUE,
      "CreateQueue",
      "<QueueOwnerID>${Soap.escape(queueOwnerUid)}</QueueOwnerID>" +
        "<QueueOwnerContext></QueueOwnerContext>" +
        "<QueuePolicy></QueuePolicy>"
    )
    if (!create.ok) return null
    return Soap.argument(create.body, "QueueID")?.toIntOrNull()
  }

  private fun parseUpdateId(body: String?, fallback: Int): Int {
    return Soap.argument(body, "NewUpdateID")?.toIntOrNull()
      ?: Soap.argument(body, "UpdateID")?.toIntOrNull()
      ?: fallback
  }

  suspend fun play(): Boolean = transport("Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")

  suspend fun pause(): Boolean {
    if (transport("Pause", "<InstanceID>0</InstanceID>")) return true
    return transport("Stop", "<InstanceID>0</InstanceID>")
  }

  suspend fun stop(): Boolean = transport("Stop", "<InstanceID>0</InstanceID>")

  suspend fun join(target: RendererSession): Boolean {
    val ownControl = avTransport ?: refreshControlUrl() ?: return false
    val targetUid = target.resolveTransportTarget()?.uid ?: return false
    return Soap.call(
      ownControl,
      Services.AV_TRANSPORT,
      "SetAVTransportURI",
      "<InstanceID>0</InstanceID>" +
        "<CurrentURI>${Soap.escape("x-rincon:$targetUid")}</CurrentURI>" +
        "<CurrentURIMetaData></CurrentURIMetaData>"
    ).ok
  }

  suspend fun ungroup(): Boolean {
    val ownControl = description.controlUrl(Services.AV_TRANSPORT) ?: refreshControlUrl() ?: return false
    return Soap.call(
      ownControl,
      Services.AV_TRANSPORT,
      "BecomeCoordinatorOfStandaloneGroup",
      INSTANCE
    ).ok
  }

  suspend fun seek(positionMs: Long): Boolean = transport(
    "Seek",
    "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit>" +
      "<Target>${Didl.hms((positionMs / 1000).toInt())}</Target>"
  )

  private suspend fun transport(action: String, arguments: String): Boolean {
    val control = avTransport ?: refreshControlUrl() ?: return false
    return Soap.call(control, Services.AV_TRANSPORT, action, arguments).ok
  }

  private suspend fun resolveTransportTarget(): TransportTarget? {
    val control = avTransport ?: refreshControlUrl() ?: return null
    val coordinator = SonosTopology.coordinatorTarget(description)
    if (coordinator != null) {
      avTransport = coordinator.controlUrl
      return TransportTarget(coordinator.controlUrl, coordinator.uid)
    }
    val uid = description.udn?.removePrefix("uuid:")?.trim()?.uppercase() ?: deviceId
    return TransportTarget(control, uid)
  }

  suspend fun setPlayMode(playMode: String): Boolean {
    val control = avTransport ?: refreshControlUrl() ?: return false
    return Soap.call(
      control,
      Services.AV_TRANSPORT,
      "SetPlayMode",
      "<InstanceID>0</InstanceID><NewPlayMode>${Soap.escape(playMode)}</NewPlayMode>"
    ).ok
  }

  suspend fun setCrossfadeMode(enabled: Boolean): Boolean {
    val control = avTransport ?: refreshControlUrl() ?: return false
    return Soap.call(
      control,
      Services.AV_TRANSPORT,
      "SetCrossfadeMode",
      "<InstanceID>0</InstanceID><CrossfadeMode>${if (enabled) 1 else 0}</CrossfadeMode>"
    ).ok
  }

  suspend fun setSleepTimer(durationSeconds: Int): Boolean {
    val control = avTransport ?: refreshControlUrl() ?: return false
    val target = Didl.hms(durationSeconds.coerceAtLeast(0))
    return Soap.call(
      control,
      Services.AV_TRANSPORT,
      "ConfigureSleepTimer",
      "<InstanceID>0</InstanceID><NewSleepTimerDuration>${Soap.escape(target)}</NewSleepTimerDuration>"
    ).ok
  }

  suspend fun setVolume(volume: Int): Boolean {
    val control = renderingControl ?: return false
    return Soap.call(
      control,
      Services.RENDERING_CONTROL,
      "SetVolume",
      "<InstanceID>0</InstanceID><Channel>Master</Channel>" +
        "<DesiredVolume>${volume.coerceIn(0, 100)}</DesiredVolume>"
    ).ok
  }

  suspend fun state(): State? {
    val control = avTransport ?: return null
    val transport = Soap.call(control, Services.AV_TRANSPORT, "GetTransportInfo", INSTANCE)
    val playbackState = Soap.argument(transport.body, "CurrentTransportState") ?: return null
    val position = Soap.call(control, Services.AV_TRANSPORT, "GetPositionInfo", INSTANCE)
    val settings = Soap.call(control, Services.AV_TRANSPORT, "GetTransportSettings", INSTANCE)
    val trackNumber = Soap.argument(position.body, "Track")?.toIntOrNull()
    return State(
      playbackState = playbackState,
      positionMs = Didl.parseDuration(Soap.argument(position.body, "RelTime")),
      durationMs = Didl.parseDuration(Soap.argument(position.body, "TrackDuration")),
      trackNumber = trackNumber,
      playMode = Soap.argument(settings.body, "PlayMode")
    )
  }

  private suspend fun refreshControlUrl(): String? {
    val fresh = Soap.fetch(location)?.let { DeviceDescription.parse(it, location) } ?: return null
    description = fresh
    avTransport = fresh.controlUrl(Services.AV_TRANSPORT)
    queueControl = fresh.controlUrl(Services.QUEUE)
    lastQueueOwnerUid = null
    lastQueueId = null
    lastQueueTrackUrls = emptyList()
    lastQueueUpdateId = 0
    return avTransport
  }

  private suspend fun refreshQueueControlUrl(): String? {
    val fresh = Soap.fetch(location)?.let { DeviceDescription.parse(it, location) } ?: return null
    description = fresh
    queueControl = fresh.controlUrl(Services.QUEUE)
    avTransport = fresh.controlUrl(Services.AV_TRANSPORT)
    lastQueueOwnerUid = null
    lastQueueId = null
    lastQueueTrackUrls = emptyList()
    lastQueueUpdateId = 0
    return queueControl
  }

  private companion object {
    const val INSTANCE = "<InstanceID>0</InstanceID>"
  }
}
