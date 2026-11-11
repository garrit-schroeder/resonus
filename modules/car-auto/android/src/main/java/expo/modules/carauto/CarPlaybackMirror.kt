package expo.modules.carauto

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

/**
 * Latest JS playback state, retained even while the car service is absent.
 * Only lives in memory: JS restores persisted playback after a process restart.
 * Updates and service attachment share the main thread, so an update queued
 * before attachment cannot be lost or replayed over a newer state.
 */
@OptIn(UnstableApi::class)
internal object CarPlaybackMirror {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var player: JsProxyPlayer? = null
  private var queue: List<JsProxyPlayer.NowPlaying> = emptyList()
  private var queueIndex = 0
  private var nowPlaying: JsProxyPlayer.NowPlaying? = null
  private var playing = false
  private var positionMs = 0L
  private var shuffle = false
  private var repeatMode = Player.REPEAT_MODE_OFF
  private var favorite: Boolean? = null
  private var favoriteLabel: String? = null

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
  }

  fun attach(newPlayer: JsProxyPlayer) = runOnMain {
    player = newPlayer
    newPlayer.applyQueue(queue, queueIndex)
    // Apply null as well: an explicit stop must not revive queue[index].
    newPlayer.applyNowPlaying(nowPlaying)
    newPlayer.applyPlaybackState(playing, positionMs, shuffle, repeatMode)
    newPlayer.applyFavorite(favorite, favoriteLabel)
    CarAutoLog.d("playback mirror attached: queue=${queue.size} index=$queueIndex playing=$playing")
  }

  fun detach(oldPlayer: JsProxyPlayer) = runOnMain {
    if (player === oldPlayer) player = null
  }

  fun setNowPlaying(value: JsProxyPlayer.NowPlaying?) = runOnMain {
    nowPlaying = value
    if (value == null) {
      playing = false
      positionMs = 0L
    }
    player?.applyNowPlaying(value)
  }

  fun setQueue(items: List<JsProxyPlayer.NowPlaying>, index: Int) = runOnMain {
    queue = items
    queueIndex = index.coerceIn(0, (items.size - 1).coerceAtLeast(0))
    items.getOrNull(queueIndex)?.let { nowPlaying = it }
    player?.applyQueue(items, queueIndex)
  }

  fun setQueueIndex(index: Int) = runOnMain {
    if (queue.isEmpty()) return@runOnMain
    queueIndex = index.coerceIn(0, queue.size - 1)
    nowPlaying = queue[queueIndex]
    player?.applyQueueIndex(queueIndex)
  }

  fun setPlaybackState(
    isPlaying: Boolean,
    posMs: Long,
    shuf: Boolean,
    repeat: Int,
    isFavorite: Boolean?,
    label: String?,
  ) = runOnMain {
    playing = isPlaying
    positionMs = posMs.coerceAtLeast(0L)
    shuffle = shuf
    repeatMode = repeat
    favorite = isFavorite
    favoriteLabel = label
    player?.applyPlaybackState(playing, positionMs, shuffle, repeatMode)
    player?.applyFavorite(favorite, favoriteLabel)
  }
}
