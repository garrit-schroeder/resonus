// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

/**
 * The MediaLibraryService that shows Android Auto the BrowseTree built in JS.
 * The session's player is a `JsProxyPlayer` whose state is pushed from JS, so
 * the mini player and the car's "Now Playing" screen show what is really
 * playing. Tapping a browsable item goes through Media3's usual browse flow;
 * tapping a playable leaf hands the mediaId, along with the parent being
 * browsed at the time, to JS through `CarAutoModule.emitPlayEvent`, so that JS
 * can queue the whole collection and start on the track that was tapped.
 */
@OptIn(UnstableApi::class)
class ResonusCarBrowserService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private var jsPlayer: JsProxyPlayer? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private lateinit var albumLoader: AlbumBrowseLoader

  override fun onCreate() {
    super.onCreate()
    CarArtwork.init(applicationContext)
    BrowseTreeCache.loadFromDiskIfNeeded(applicationContext)
    albumLoader = AlbumBrowseLoader(applicationContext, mainHandler, { id, parent, profile ->
      CarAutoModule.instance?.emitBrowse(id, parent, profile) == true
    }, ::notifyTreeChanged)
    val player = JsProxyPlayer().also {
      jsPlayer = it
      activePlayer = it
      CarPlaybackMirror.attach(it)
    }
    session = MediaLibrarySession.Builder(this, player, LibraryCallback())
      .setId("ResonusCarBrowserSession")
      .setMediaButtonPreferences(modeButtons(player))
      .build()
    activeService = this
    // Each of those two buttons carries the state it will put the player in,
    // so its icon has to be rebuilt whenever the state changes: shuffle turned
    // on from the phone has to come out lit in the car, and pressing it there
    // has to turn it off rather than on again.
    player.addListener(object : Player.Listener {
      override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) = refreshModeButtons()
      override fun onRepeatModeChanged(repeatMode: Int) = refreshModeButtons()
    })
    player.onFavoriteChanged = { refreshModeButtons() }
  }

  private fun refreshModeButtons() {
    val player = jsPlayer ?: return
    session?.setMediaButtonPreferences(modeButtons(player))
  }

  /**
   * Shuffle and repeat for the car's playback screen.
   *
   * Both are plain player commands rather than commands of our own, so the
   * host acts on the session directly and it lands in `JsProxyPlayer`, which
   * already forwards both to JS. Each carries the value to move to: without a
   * parameter media3 toggles shuffle by reading the player back, and cycling
   * repeat is ours to define anyway (off, all, one).
   */
  private fun modeButtons(player: JsProxyPlayer): ImmutableList<CommandButton> {
    val shuffleOn = player.shuffleModeEnabled
    val nextRepeat = when (player.repeatMode) {
      Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
      Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
      else -> Player.REPEAT_MODE_OFF
    }
    val buttons = ImmutableList.builder<CommandButton>()
    buttons.add(
      CommandButton.Builder(
        if (shuffleOn) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF,
      )
        .setPlayerCommand(Player.COMMAND_SET_SHUFFLE_MODE, !shuffleOn)
        .setDisplayName(getString(R.string.car_shuffle))
        .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
        .build(),
      CommandButton.Builder(
        when (player.repeatMode) {
          Player.REPEAT_MODE_ONE -> CommandButton.ICON_REPEAT_ONE
          Player.REPEAT_MODE_ALL -> CommandButton.ICON_REPEAT_ALL
          else -> CommandButton.ICON_REPEAT_OFF
        },
      )
        .setPlayerCommand(Player.COMMAND_SET_REPEAT_MODE, nextRepeat)
        .setDisplayName(getString(R.string.car_repeat))
        .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
        .build(),
    )
    // The heart: a command of our own, since favourites are not player state.
    player.favorite?.let { favorite ->
      buttons.add(
        CommandButton.Builder(
          if (favorite) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED,
        )
          .setSessionCommand(SessionCommand(FAVORITE_COMMAND, Bundle.EMPTY))
          .setDisplayName(player.favoriteLabel ?: "Favorite")
          .setSlots(CommandButton.SLOT_OVERFLOW)
          .build(),
      )
    }
    return buttons.build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  // This is a bound mirror, not the audio engine. expo-audio's playback
  // service already owns the foreground notification. Restoring a playing
  // mirror must not start a second foreground service from the background.
  override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) = Unit

  override fun onDestroy() {
    albumLoader.close()
    jsPlayer?.let(CarPlaybackMirror::detach)
    if (activeService === this) activeService = null
    if (activePlayer === jsPlayer) activePlayer = null
    session?.run { player.release(); release() }
    session = null
    jsPlayer = null
    super.onDestroy()
  }

  private fun notifyTreeChanged(changed: Map<String, Int>) {
    mainHandler.post {
      albumLoader.onTreeChanged()
      if (changed.isEmpty()) return@post
      val currentSession = session ?: return@post
      for ((parentId, itemCount) in changed) {
        currentSession.notifyChildrenChanged(parentId, itemCount, null)
      }
      CarAutoLog.d("notified changedParents=${changed.size}")
    }
  }

  private inner class LibraryCallback : MediaLibrarySession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(
          MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
            .add(SessionCommand(FAVORITE_COMMAND, Bundle.EMPTY))
            .build(),
        )
        .build()

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction == FAVORITE_COMMAND) {
        CarAutoModule.instance?.emitTransport("favorite", null)
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      return super.onCustomCommand(session, controller, customCommand, args)
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      // The car is opening the app: whatever songs the tree is missing, this
      // is the moment to go and get them, and the phone is awake for it. Not
      // for a root asked for as "recent": that is the system's own media
      // resumption (SystemUI on boot, say), not somebody in a car, and taking
      // it for one filled the whole tree on phones that never saw a car (#221).
      // `projection` is Android Auto itself, as opposed to any other browser
      // (a watch, the assistant): the car plays what the phone plays, so
      // whatever was on a speaker comes back to the phone (#272).
      if (params?.isRecent != true) {
        CarAutoModule.instance?.emitConnected(browser.packageName == ANDROID_AUTO_PACKAGE)
      }
      val rootExtras = Bundle().apply {
        // Hints for Android Auto: the root's children are drawn as tabs
        // (category list items), and anything browsable below that as a list.
        putInt(
          MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
          MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_CATEGORY_LIST_ITEM,
        )
        putInt(
          MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
          MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        )
      }
      val root = MediaItem.Builder()
        .setMediaId(BrowseTreeCache.ROOT_ID)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .build(),
        )
        .build()
      // The hints ride in the params, not in the item: what reaches the car is
      // the bundle media3 builds out of `result.params.extras`, and anything
      // left on the root's own metadata is dropped on the way
      // (`MediaLibraryServiceLegacyStub.onGetRoot`). Put there, the tabs were
      // being drawn however Android Auto felt like. The ones passed in are the
      // browser's own request hints and are not ours to echo back.
      val rootParams = LibraryParams.Builder().setExtras(rootExtras).build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, rootParams))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val node = findNode(mediaId)
        ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
      return Futures.immediateFuture(LibraryResult.ofItem(node.toMediaItem(), null))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val children = BrowseTreeCache.getChildren(parentId)
      CarAutoLog.d("children of=$parentId have=${children.size} page=$page pageSize=$pageSize")
      if (children.isEmpty() && parentId.startsWith("album:") && findNode(parentId) != null) {
        // Wait for exactly this album. Returning an empty success here made
        // every album beyond the prefetch cap appear permanently empty.
        return Futures.transform(albumLoader.load(parentId), { loaded ->
          if (loaded == true) pageOf(BrowseTreeCache.getChildren(parentId), page, pageSize, params)
          else LibraryResult.ofError(SessionError.ERROR_IO)
        }, MoreExecutors.directExecutor())
      }
      // Paged, like the search results and for the same reason (see `pageOf`).
      return Futures.immediateFuture(pageOf(children, page, pageSize, params))
    }

    /**
     * Answered from the cached tree, without asking JS: the car searches with
     * the screen off, and that is exactly when React Native stops running
     * timers and its requests stop coming back (#103). media3 announces to the
     * car that search exists on its own, from the session commands, so this is
     * the only thing that was missing.
     *
     * The work happens here and the results are kept, because the count
     * reported now and the items handed over in `onGetSearchResult` have to be
     * the same list.
     */
    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      val results = resultsFor(query)
      CarAutoLog.d("search q=$query hits=${results.size}")
      session.notifySearchResultChanged(browser, query, results.size, params)
      return Futures.immediateFuture(LibraryResult.ofVoid(params))
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
      Futures.immediateFuture(pageOf(resultsFor(query), page, pageSize, params))

    /**
     * The window the controller asked for, and nothing more.
     *
     * Local covers travel as bytes, because the host cannot read a `file://`
     * of ours, and a page of them adds up: a library kept offline has every
     * cover local, and twenty-odd of them at full size is most of the binder's
     * one megabyte. Over that limit the whole answer is dropped on the way and
     * the car draws an empty list, which is what it was doing for playlists,
     * starred albums and the results of a search (#140).
     *
     * So they go at tile size, and past a byte budget the rest fall back to
     * their uri: a local one the host cannot draw, but the item itself still
     * arrives. A list missing some covers beats a list missing everything.
     */
    private fun pageOf(
      all: List<BrowseNode>,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): LibraryResult<ImmutableList<MediaItem>> {
      val from = page.toLong() * pageSize.toLong()
      if (from !in 0 until all.size.toLong()) {
        return LibraryResult.ofItemList(ImmutableList.of(), params)
      }
      val start = from.toInt()
      val end = minOf(from + pageSize.toLong(), all.size.toLong()).toInt()
      val items = ImmutableList.builder<MediaItem>()
      var budget = ART_BUDGET_BYTES
      var dropped = 0
      for (node in all.subList(start, end)) {
        val (item, used) = node.toMediaItemWithArt(embed = budget > 0)
        if (used == 0 && node.artworkUrl != null && budget <= 0) dropped++
        budget -= used
        items.add(item)
      }
      CarAutoLog.d("children n=${end - start} artBytes=${ART_BUDGET_BYTES - budget} noArt=$dropped")
      return LibraryResult.ofItemList(items.build(), params)
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      val first = mediaItems.firstOrNull()
      val id = first?.mediaId
      if (id.isNullOrEmpty()) {
        val spoken = spokenPick(first) ?: return Futures.immediateFuture(mediaItems)
        return Futures.immediateFuture(mutableListOf(spoken.toMediaItem()))
      }
      return resolvePlayable(id, mediaItems)
    }

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val first = mediaItems.firstOrNull()
      val id = first?.mediaId
      // "Play <something>" arrives with no id at all and what was said in the
      // request's `searchQuery`, so the tree is searched for it. Left alone,
      // every spoken request was dropped here (#103).
      if (id.isNullOrEmpty()) {
        val spoken = spokenPick(first)
        return Futures.immediateFuture(
          if (spoken == null) {
            MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs)
          } else {
            MediaSession.MediaItemsWithStartPosition(mutableListOf(spoken.toMediaItem()), 0, 0L)
          },
        )
      }
      val node = findNode(id)
      if (node != null && node.playable) {
        jsPlayer?.applyTappedItem(node)
        emitPlay(id)
        return Futures.immediateFuture(
          MediaSession.MediaItemsWithStartPosition(
            mutableListOf(node.toMediaItem()),
            0,
            0L,
          ),
        )
      }
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs),
      )
    }

    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
      Futures.immediateFailedFuture(UnsupportedOperationException("no resumption state"))

    /**
     * What to start playing for a spoken request, already handed to JS.
     *
     * A track gets the optimistic metadata the car shows while JS resolves it,
     * the same as a tap. A collection does not: what it puts on is its first
     * song, and naming the album where the song goes would be a worse answer
     * than the spinner that is already there.
     */
    private fun spokenPick(item: MediaItem?): BrowseNode? {
      val query = item?.requestMetadata?.searchQuery
      val node = BrowseTreeCache.voicePick(query?.toString())
      CarAutoLog.d("voice q=$query pick=${node?.id}")
      if (node == null) return null
      if (node.playable) jsPlayer?.applyTappedItem(node)
      emitPlay(node.id)
      return node
    }

    private fun resolvePlayable(
      mediaId: String,
      original: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      emitPlay(mediaId)
      val node = findNode(mediaId)
      if (node != null && node.playable) {
        jsPlayer?.applyTappedItem(node)
        return Futures.immediateFuture(mutableListOf(node.toMediaItem()))
      }
      return Futures.immediateFuture(original)
    }

    private fun emitPlay(mediaId: String) {
      val parentId = BrowseTreeCache.findParentOf(mediaId)
      CarAutoLog.d("emitPlay id=$mediaId parent=$parentId")
      CarAutoModule.instance?.emitPlayEvent(mediaId, parentId)
    }
  }

  /** The last query answered, kept so the count reported to the car and the
   *  items it then asks for cannot disagree. */
  @Volatile private var lastSearch: Pair<String, List<BrowseNode>>? = null

  private fun resultsFor(query: String): List<BrowseNode> {
    lastSearch?.let { (q, results) -> if (q == query) return results }
    val results = BrowseTreeCache.search(query)
    lastSearch = query to results
    return results
  }

  private fun findNode(mediaId: String): BrowseNode? {
    BrowseTreeCache.getChildren(BrowseTreeCache.ROOT_ID).firstOrNull { it.id == mediaId }?.let { return it }
    val seen = HashSet<String>()
    val stack = ArrayDeque<String>()
    stack.addLast(BrowseTreeCache.ROOT_ID)
    while (stack.isNotEmpty()) {
      val pid = stack.removeLast()
      if (!seen.add(pid)) continue
      for (c in BrowseTreeCache.getChildren(pid)) {
        if (c.id == mediaId) return c
        if (!c.playable) stack.addLast(c.id)
      }
    }
    return null
  }

  companion object {
    @Volatile var activePlayer: JsProxyPlayer? = null
      private set
    @Volatile private var activeService: ResonusCarBrowserService? = null

    fun notifyTreeChanged(changed: Map<String, Int>) {
      activeService?.notifyTreeChanged(changed)
    }

    fun browseReady() {
      activeService?.let { service -> service.mainHandler.post { service.albumLoader.onReady() } }
    }

    fun completeBrowse(requestId: String, json: String?) {
      activeService?.let { service -> service.mainHandler.post { service.albumLoader.complete(requestId, json) } }
    }

    /** The heart on the car's playback screen. */
    const val FAVORITE_COMMAND = "expo.modules.carauto.FAVORITE"

    /** Android Auto's own package, the one browsing the library from a car. */
    private const val ANDROID_AUTO_PACKAGE = "com.google.android.projection.gearhead"

    /**
     * How much cover art one page of browse results may carry. Below the
     * binder's one megabyte with room to spare for the rest of the parcel:
     * the titles, the ids and the extras of every item ride in it too.
     */
    private const val ART_BUDGET_BYTES = 512 * 1024
  }
}

@OptIn(UnstableApi::class)
private fun BrowseNode.toMediaItem(): MediaItem = toMediaItemWithArt(embed = true).first

/** The item, and how many bytes of cover art it ended up carrying. */
@OptIn(UnstableApi::class)
private fun BrowseNode.toMediaItemWithArt(embed: Boolean): Pair<MediaItem, Int> {
  val extras = Bundle()
  // contentStyle on a browsable node tells AA how to draw *its children*.
  if (!playable) {
    val styleValue = when (contentStyle) {
      "grid" -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
      "list" -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
      else -> MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
    }
    extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, styleValue)
    extras.putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, styleValue)
  }
  // Neighbours carrying the same heading are drawn as one group under it, so a
  // tab can hold several shelves without spending a screen on each of them.
  if (group != null) {
    extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group)
  }
  val builder = MediaMetadata.Builder()
    .setTitle(title)
    .setSubtitle(subtitle)
    .setIsBrowsable(!playable)
    .setIsPlayable(playable)
    // The kind matters to how the car draws it: an artist comes out as a
    // circle and an album as a square, and a folder is what it falls back to
    // for anything that does not say what it is.
    .setMediaType(
      when {
        playable -> MediaMetadata.MEDIA_TYPE_MUSIC
        mediaType == "artist" -> MediaMetadata.MEDIA_TYPE_ARTIST
        mediaType == "album" -> MediaMetadata.MEDIA_TYPE_ALBUM
        mediaType == "playlist" -> MediaMetadata.MEDIA_TYPE_PLAYLIST
        else -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
      },
    )
    .setExtras(extras)
  val artBytes = CarArtwork.apply(builder, artworkUrl, embed, CarArtwork.THUMB_DIM)
  val item = MediaItem.Builder()
    .setMediaId(id)
    .setMediaMetadata(builder.build())
    .build()
  return item to artBytes
}
