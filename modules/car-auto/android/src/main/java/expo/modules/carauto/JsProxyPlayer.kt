// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A Media3 player fed by JS, which tells it the current track and whether it is
 * playing, and whose transport commands go back to JS as CarAutoModule
 * `transport` events. It backs the MediaLibrarySession Android Auto talks to,
 * so the car's mini player and "Now Playing" screen show what is really playing
 * (expo-audio) without a second audio engine behind them.
 */
@OptIn(UnstableApi::class)
class JsProxyPlayer : SimpleBasePlayer(Looper.getMainLooper()) {

  data class NowPlaying(
    val id: String,
    val title: String?,
    val artist: String?,
    val album: String?,
    val artworkUrl: String?,
    val durationMs: Long,
  )

  @Volatile private var nowPlaying: NowPlaying? = null
  // The queue and the current index, mirrored from JS. While it is not empty
  // the player shows it as its playlist, so AA's queue view has the whole
  // collection. nowPlaying is still the authority on the metadata: it can carry
  // a more refined version of queue[index].
  @Volatile private var queue: List<NowPlaying> = emptyList()
  private data class QueueItemUid(val mediaId: String, val occurrence: Int)
  private var queueUids: List<QueueItemUid> = emptyList()
  @Volatile private var currentIndex: Int = 0
  @Volatile private var playing: Boolean = false
  @Volatile private var positionMs: Long = 0L
  @Volatile private var positionUpdatedAt: Long = System.currentTimeMillis()
  @Volatile private var shuffle: Boolean = false
  @Volatile private var repeatMode: Int = Player.REPEAT_MODE_OFF
  // Where the slice of the queue the car was last handed starts in the whole
  // queue (see `getState`), so a tap on its row N is row N + this in JS.
  @Volatile private var windowStart: Int = 0

  /** Whether the song is a favourite, for the heart; null hides it. Not player
   *  state, so it is the service that draws it (see `onFavoriteChanged`). */
  @Volatile var favorite: Boolean? = null
    private set
  @Volatile var favoriteLabel: String? = null
    private set
  var onFavoriteChanged: (() -> Unit)? = null

  fun applyFavorite(value: Boolean?, label: String?) = runOnMain {
    if (favorite == value && favoriteLabel == label) return@runOnMain
    favorite = value
    favoriteLabel = label
    onFavoriteChanged?.invoke()
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  // SimpleBasePlayer insists on its application thread (main), and calls from
  // JS land on the JS thread, so we hop to the main looper before mutating and
  // invalidating.
  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
  }

  fun applyNowPlaying(np: NowPlaying?) = runOnMain {
    nowPlaying = np
    if (np == null) {
      playing = false
      positionMs = 0L
    }
    positionUpdatedAt = System.currentTimeMillis()
    invalidateState()
  }

  // An optimistic placeholder, applied the moment a leaf is tapped in Android
  // Auto and before JS has finished resolving the track and starting it. It
  // turns AA's "searching" spinner into the metadata of the track that was
  // tapped; the real now-playing from JS fills in duration and artist after.
  fun applyTappedItem(node: BrowseNode) = runOnMain {
    nowPlaying = NowPlaying(
      id = node.id,
      title = node.title,
      artist = node.subtitle,
      album = null,
      artworkUrl = node.artworkUrl,
      durationMs = 0L,
    )
    playing = true
    positionMs = 0L
    positionUpdatedAt = System.currentTimeMillis()
    invalidateState()
  }

  fun applyQueue(items: List<NowPlaying>, index: Int) = runOnMain {
    // Count across the whole queue, before taking the car's moving window.
    // A song may legitimately appear twice. A typed key avoids collisions
    // between a repeated ID and a real ID containing a suffix such as "#1".
    val occurrences = HashMap<String, Int>()
    queueUids = items.map { item ->
      val occurrence = occurrences[item.id] ?: 0
      occurrences[item.id] = occurrence + 1
      QueueItemUid(item.id, occurrence)
    }
    queue = items
    currentIndex = index.coerceIn(0, (items.size - 1).coerceAtLeast(0))
    if (items.isNotEmpty()) {
      val cur = items.getOrNull(currentIndex)
      if (cur != null) nowPlaying = cur
    }
    invalidateState()
  }

  // A cheap move of the cursor within the queue already mirrored here, so
  // skipping a track does not need the whole list sent over from JS again.
  fun applyQueueIndex(index: Int) = runOnMain {
    if (queue.isEmpty()) return@runOnMain
    currentIndex = index.coerceIn(0, queue.size - 1)
    queue.getOrNull(currentIndex)?.let { nowPlaying = it }
    invalidateState()
  }

  fun applyPlaybackState(isPlaying: Boolean, posMs: Long, shuf: Boolean, repeat: Int) = runOnMain {
    playing = isPlaying
    positionMs = posMs.coerceAtLeast(0L)
    positionUpdatedAt = System.currentTimeMillis()
    shuffle = shuf
    repeatMode = repeat
    invalidateState()
  }

  override fun getState(): State {
    val np = nowPlaying
    val q = queue
    // The queue pushed from JS wins. It falls back to the optimistic
    // single-item playlist while the queue has not been mirrored yet, which is
    // the moment right after a tap.
    // Only a slice of the queue around the current track. The whole timeline
    // travels in one binder transaction, and the artwork budget below bounded
    // the covers but not the rest: a queue of a few thousand songs (a big
    // favourites list played shuffled) carried thousands of titles, artists
    // and ids and went over the transaction limit, which takes the app down.
    // Nobody scrolls the car's queue that far, and the slice moves with the
    // track.
    val full = q.isNotEmpty()
    val qIndex = if (full) currentIndex.coerceIn(0, q.size - 1) else 0
    val start = if (full) (qIndex - QUEUE_BEFORE).coerceAtLeast(0) else 0
    val end = if (full) (qIndex + QUEUE_AFTER + 1).coerceAtMost(q.size) else 0
    windowStart = start
    val source: List<NowPlaying> = when {
      full -> q.subList(start, end)
      np != null -> listOf(np)
      else -> emptyList()
    }
    val activeIndex = qIndex - start

    // Local covers go as bytes so AA's "Now Playing", its queue and its home
    // card can draw file:// covers its own process cannot read. The whole queue
    // travels in a single player-state transaction, so how much artwork is
    // embedded has to be limited: the current item always carries its own (the
    // big one on Now Playing) and the rest are embedded in order until a byte
    // budget runs out, after which they fall back to the uri, which a local
    // file cannot be read from but is at least small. That keeps the timeline
    // under the binder transaction limit.
    val builder = ImmutableList.builder<MediaItemData>()
    var artBudget = ART_BUDGET_BYTES
    for ((i, item) in source.withIndex()) {
      val isCurrent = i == activeIndex
      val embed = isCurrent || artBudget > 0
      val uid = if (full) queueUids[start + i] else QueueItemUid(item.id, 0)
      val used = item.toMediaItemDataInto(builder, uid, embed)
      if (!isCurrent) artBudget -= used
    }
    val items = builder.build()

    val extrapolated = if (playing) {
      positionMs + (System.currentTimeMillis() - positionUpdatedAt)
    } else {
      positionMs
    }

    val commands = Player.Commands.Builder()
      .add(Player.COMMAND_PLAY_PAUSE)
      .add(Player.COMMAND_PREPARE)
      .add(Player.COMMAND_SET_MEDIA_ITEM)
      .add(Player.COMMAND_CHANGE_MEDIA_ITEMS)
      .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_NEXT)
      .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
      .add(Player.COMMAND_SET_SHUFFLE_MODE)
      .add(Player.COMMAND_SET_REPEAT_MODE)
      .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
      .add(Player.COMMAND_GET_METADATA)
      .add(Player.COMMAND_GET_TIMELINE)
      .build()

    return State.Builder()
      .setAvailableCommands(commands)
      .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaybackState(if (np != null) Player.STATE_READY else Player.STATE_IDLE)
      .setPlaylist(items)
      .setCurrentMediaItemIndex(if (items.isEmpty()) 0 else activeIndex)
      .setContentPositionMs(extrapolated.coerceAtLeast(0L))
      .setShuffleModeEnabled(shuffle)
      .setRepeatMode(repeatMode)
      .build()
  }

  // Builds the timeline item and adds it to [out]. Returns how many bytes of
  // artwork it embedded, so the caller can budget the player-state binder
  // transaction; with [embed] false the cover falls back to its uri.
  private fun NowPlaying.toMediaItemDataInto(
    out: ImmutableList.Builder<MediaItemData>,
    uid: QueueItemUid,
    embed: Boolean,
  ): Int {
    val metadata = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setAlbumTitle(album)
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
    val used = CarArtwork.apply(metadata, artworkUrl, embed)
    val mi = MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(metadata.build())
      .build()
    out.add(
      MediaItemData.Builder(uid)
        .setMediaItem(mi)
        .setDurationUs(if (durationMs > 0) durationMs * 1000 else C.TIME_UNSET)
        .build()
    )
    return used
  }

  private companion object {
    // Ceiling on queue artwork embedded per state push (~768KB), leaving room
    // under the binder transaction limit (~1MB) for the rest of the timeline:
    // the titles, the ids and the durations.
    const val ART_BUDGET_BYTES = 768 * 1024

    // The slice of the queue the car is shown: a few behind the current track
    // and enough ahead for anyone scrolling it at a red light.
    const val QUEUE_BEFORE = 20
    const val QUEUE_AFTER = 100
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    CarAutoModule.instance?.emitTransport(
      if (playWhenReady) "play" else "pause",
      null,
    )
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSetMediaItems(
    mediaItems: List<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleAddMediaItems(
    index: Int,
    mediaItems: List<MediaItem>,
  ): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSeek(
    mediaItemIndex: Int,
    positionMs: Long,
    seekCommand: Int,
  ): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ->
        CarAutoModule.instance?.emitTransport("next", null)
      Player.COMMAND_SEEK_TO_PREVIOUS,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM ->
        CarAutoModule.instance?.emitTransport("previous", null)
      Player.COMMAND_SEEK_TO_MEDIA_ITEM ->
        CarAutoModule.instance?.emitTransport("seekToIndex", (windowStart + mediaItemIndex).toDouble())
      else -> {
        // Everything left is a position inside the song, and the one value that
        // is not a position at all has to come off here. media3 passes
        // C.TIME_UNSET to mean "wherever this item starts" (`BasePlayer`'s
        // `seekToDefaultPositionInternal`, which is what a queue tap and a
        // finished playlist go through), and that constant is Long.MIN_VALUE
        // plus one, not a time. Forwarded as it stood, JS read it as a second
        // and asked the player to seek nine quintillion of them back.
        val target = if (positionMs == C.TIME_UNSET) 0L else positionMs.coerceAtLeast(0L)
        applySeekLocally(target)
        CarAutoModule.instance?.emitTransport("seek", target.toDouble())
      }
    }
    return Futures.immediateVoidFuture()
  }

  /**
   * Moves the position here too, and not only in JS.
   *
   * The car draws its bar from this player, and this player is told where
   * playback is once a second. Between a seek and the next of those the state
   * handed back was still the one from before, so the bar sprang back to where
   * it had just been dragged from. The push that follows overwrites this with
   * whatever is true, which is also what puts the bar back if the seek did not
   * take.
   */
  private fun applySeekLocally(posMs: Long) {
    positionMs = posMs
    positionUpdatedAt = System.currentTimeMillis()
  }

  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
    CarAutoModule.instance?.emitTransport(
      "shuffle",
      if (shuffleModeEnabled) 1.0 else 0.0,
    )
    return Futures.immediateVoidFuture()
  }

  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
    val v = when (repeatMode) {
      Player.REPEAT_MODE_ONE -> "one"
      Player.REPEAT_MODE_ALL -> "all"
      else -> "off"
    }
    CarAutoModule.instance?.emitTransportString("repeat", v)
    return Futures.immediateVoidFuture()
  }
}
