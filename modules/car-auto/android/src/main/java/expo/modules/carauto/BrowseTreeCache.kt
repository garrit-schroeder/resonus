// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.Normalizer
import java.util.Locale

data class BrowseNode(
  val id: String,
  val title: String,
  val subtitle: String?,
  val artworkUrl: String?,
  val playable: Boolean,
  val contentStyle: String?, // "list" | "grid" | null
  val mediaType: String?, // "album" | "artist" | "playlist" | null
  val group: String?, // heading this item is drawn under, if any
)

object BrowseTreeCache {
  private const val SNAPSHOT_FILE = "carauto_tree.json"
  const val ROOT_ID = "root"

  @Volatile private var nodes: Map<String, List<BrowseNode>> = emptyMap()
  @Volatile private var loaded: Boolean = false
  /** Which account the tree in hand belongs to, so another one's albums are
   *  never merged into it. Null for a tree pushed before this was written. */
  @Volatile private var profile: String? = null
  /** Albums explicitly opened by the driver must survive a capped rebuild. */
  private const val MAX_DEMAND_ALBUMS = 40
  private val demandedAlbums = LinkedHashSet<String>()
  // The last browsable parent opened in Android Auto. It travels with a play
  // event so JS can queue the whole collection (the album, the playlist, the
  // section of Home) rather than only the track that was tapped.
  @Volatile private var lastBrowsedParent: String? = null

  /**
   * Takes a tree from JS, whole or in part.
   *
   * The app pushes the lists within a second of opening and the songs inside
   * them a good while later, because filling the whole thing in is dozens of
   * requests and doing that at launch competed with the launch itself (#50).
   * The first of those two carries no album's songs at all, so taking it as
   * the whole truth emptied every album in the car until the second one
   * arrived, and wrote that emptiness over the snapshot on disk, which is what
   * Android Auto reads when it starts the service by itself. A partial push is
   * therefore laid over what is already here rather than replacing it.
   *
   * Only what belongs to the account in hand: signing into another one pushes
   * a partial tree too, and merging that would leave the car browsing the
   * albums of an account that is no longer open.
   */
  @Synchronized fun setFromJson(context: Context, json: String): Map<String, Int> {
    val incoming = parse(json) ?: return emptyMap()
    // What is on disk is the last tree that had songs in it. Read it before
    // deciding what to keep, or a partial push on a cold start has nothing to
    // be laid over and the albums come back empty anyway.
    loadFromDiskIfNeeded(context)
    val before = nodes
    // An empty offline album may gain tracks when the user goes online.
    // Revalidate negative entries on a list/mode refresh, not on every page.
    demandedAlbums.removeAll { nodes[it].isNullOrEmpty() }
    val sameAccount = profile == null || incoming.profile == null || profile == incoming.profile
    val keepWhatWeHave = incoming.partial && sameAccount
    if (!sameAccount) demandedAlbums.clear()
    val retained = if (sameAccount) nodes.filterKeys {
      it in demandedAlbums && incoming.nodes[it].isNullOrEmpty()
    } else emptyMap()
    nodes = if (keepWhatWeHave) nodes + incoming.nodes else incoming.nodes + retained
    profile = incoming.profile ?: profile.takeIf { sameAccount }
    loaded = true
    runCatching {
      val file = File(context.filesDir, SNAPSHOT_FILE)
      // Only a whole tree is worth keeping for the next time the car starts
      // the service on its own. A partial one holds no songs, and the point of
      // the snapshot is precisely the songs.
      if (!incoming.partial) writeSnapshot(context)
      // Nothing to lay this over, so what is on disk is another account's.
      else if (!sameAccount) file.delete()
    }
    return (before.keys + nodes.keys)
      .filter { parentId -> before[parentId] != nodes[parentId] }
      .associateWith { parentId -> nodes[parentId]?.size ?: 0 }
  }

  // For when JS has not pushed a tree into this process yet, which is what
  // happens when Android Auto starts the service on its own.
  @Synchronized fun loadFromDiskIfNeeded(context: Context) {
    if (loaded) return
    loaded = true
    runCatching {
      val file = File(context.filesDir, SNAPSHOT_FILE)
      if (file.exists()) {
        parse(file.readText())?.let {
          nodes = it.nodes
          profile = it.profile
          demandedAlbums.addAll(it.demandedAlbums)
        }
      }
    }
  }

  fun profileId(): String? = profile

  @Synchronized fun hasAlbumChildren(parentId: String): Boolean =
    !nodes[parentId].isNullOrEmpty() || parentId in demandedAlbums

  /** Strictly scoped response to a pending request; never switches accounts. */
  @Synchronized fun mergeAlbum(context: Context, json: String, expectedProfile: String, parentId: String): Boolean {
    val incoming = parse(json) ?: return false
    if (profile != expectedProfile || incoming.profile != expectedProfile ||
        incoming.nodes.keys != setOf(parentId) || !parentId.startsWith("album:")) return false
    val children = incoming.nodes.getValue(parentId)
    if (children.any { !it.playable || !it.id.startsWith("track|$parentId|") }) return false
    nodes = nodes + incoming.nodes
    demandedAlbums.remove(parentId)
    demandedAlbums.add(parentId)
    if (demandedAlbums.size > MAX_DEMAND_ALBUMS) {
      val oldest = demandedAlbums.first()
      demandedAlbums.remove(oldest)
      nodes = nodes - oldest
    }
    runCatching { writeSnapshot(context) }
    return true
  }

  private fun writeSnapshot(context: Context) {
    val parents = JSONObject()
    for ((id, children) in nodes) {
      parents.put(id, JSONArray().apply {
        children.forEach { node -> put(JSONObject().apply {
          put("id", node.id); put("title", node.title); put("playable", node.playable)
          put("subtitle", node.subtitle); put("artworkUrl", node.artworkUrl)
          put("contentStyle", node.contentStyle); put("mediaType", node.mediaType); put("group", node.group)
        }) }
      })
    }
    val json = JSONObject().put("nodes", parents).put("profile", profile)
      .put("demandedAlbums", JSONArray(demandedAlbums.toList())).toString()
    val temp = File(context.filesDir, "$SNAPSHOT_FILE.tmp")
    temp.writeText(json)
    if (!temp.renameTo(File(context.filesDir, SNAPSHOT_FILE))) temp.delete()
  }

  fun getChildren(parentId: String): List<BrowseNode> {
    val children = nodes[parentId] ?: emptyList()
    // The deepest parent that actually holds playable leaves is the collection
    // AA was browsing when a track was tapped, so that is the one worth keeping.
    if (children.any { it.playable }) lastBrowsedParent = parentId
    return children
  }

  fun lastBrowsedParent(): String? = lastBrowsedParent

  // Best effort: the id of the parent the tapped track lives in, when that
  // parent is known. Falls back to the last one browsed if the track cannot be
  // resolved from the cache, which is rare and only happens while it is warming
  // up. JS is the authority now (a track's mediaId carries its parent), so this
  // is only here for older ids that carry none.
  fun findParentOf(childId: String): String? {
    for ((pid, list) in nodes) {
      if (list.any { it.id == childId }) return pid
    }
    return lastBrowsedParent
  }

  fun debugSummary(): String {
    val root = nodes[ROOT_ID]?.size ?: 0
    // How many collections have their songs, which is the difference between a
    // wall of covers that plays and one that opens onto nothing.
    val filled = nodes.count { (_, list) -> list.any { it.playable } }
    return "root=$root totalParents=${nodes.size} withSongs=$filled"
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  // Answered from this cache and nowhere else. The car asks with the screen off
  // and the phone locked, which is when React Native stops running timers and
  // its `fetch` stops resolving, so anything that had to go through JS to
  // answer would answer nothing at all (#103). The price is honest: it finds
  // what the tree holds, which is the shelves plus the songs of the albums that
  // were prefetched, not the whole library.

  /** Ceiling on what a query returns. The car pages through them anyway. */
  private const val MAX_RESULTS = 60

  /**
   * Everything in the tree matching `query`, best match first.
   *
   * The same album sits under several parents (a shelf and the library), and
   * the same song under an album and its artist, so results are deduplicated:
   * by id, and for a track by the song it points at, since its id carries the
   * parent it was found in.
   */
  fun search(query: String): List<BrowseNode> {
    val q = fold(query)
    if (q.isEmpty()) return emptyList()
    val tokens = q.split(' ').filter { it.isNotEmpty() }
    val seen = HashSet<String>()
    val hits = ArrayList<Pair<BrowseNode, Int>>()
    for ((_, children) in nodes) {
      for (node in children) {
        if (!seen.add(dedupeKey(node))) continue
        val score = score(node, q, tokens)
        if (score > 0) hits.add(node to score)
      }
    }
    // Sorting is stable, so nodes of equal worth stay in the order the tree
    // holds them, and a collection comes before a single track: it is the
    // shorter way to say the same thing, and one tap plays all of it.
    return hits
      .sortedWith(compareByDescending<Pair<BrowseNode, Int>> { it.second }.thenBy { it.first.playable })
      .take(MAX_RESULTS)
      .map { it.first }
  }

  /** The song a track id points at, or the node's own id. */
  private fun dedupeKey(node: BrowseNode): String =
    if (node.id.startsWith("track|")) node.id.substringAfter('|').substringAfter('|') else node.id

  /**
   * How well a node answers the query, 0 for not at all.
   *
   * What was typed against the title first, and only then against the line
   * under it, halved: an artist's name matching a song's subtitle exactly is
   * still worth more than an album whose title merely contains the word.
   */
  private fun score(node: BrowseNode, q: String, tokens: List<String>): Int {
    val title = score(node.title, q, tokens)
    if (title > 0) return title
    return score(node.subtitle, q, tokens) / 2
  }

  private fun score(text: String?, q: String, tokens: List<String>): Int {
    val t = fold(text ?: return 0)
    if (t.isEmpty()) return 0
    if (t == q) return 100
    if (t.startsWith(q)) return 80
    val words = t.split(' ')
    // "dark side" finds "The Dark Side of the Moon", and so does "moon": every
    // word typed has to start a word of the title, in any order.
    if (tokens.all { tok -> words.any { it.startsWith(tok) } }) return 60
    if (tokens.all { t.contains(it) }) return 40
    return 0
  }

  // Hoisted: `fold` runs on every title and every subtitle in the tree, and
  // building these inside it meant compiling two patterns a few thousand times
  // per query.
  private val MARKS = Regex("\\p{Mn}+")
  private val SPACES = Regex("\\s+")

  /** Lowercase, unaccented and single-spaced, so "Bjork" finds "Björk". */
  private fun fold(s: String): String {
    val stripped = Normalizer.normalize(s, Normalizer.Form.NFD).replace(MARKS, "")
    return stripped.lowercase(Locale.ROOT).replace(SPACES, " ").trim()
  }

  /**
   * The one thing to start playing for a spoken request, or null if the tree
   * holds nothing that could answer it.
   *
   * Only what JS knows how to resolve: a track, an album, an artist, a playlist
   * or the favourites. The tabs and the shelves are places to browse, not
   * answers to "play something", and offering one would start silence.
   */
  fun voicePick(query: String?): BrowseNode? {
    // "Play music", with nothing said about what. The favourites are the
    // closest thing to an answer the tree has.
    val hit =
      if (query.isNullOrBlank()) firstPlayableCollection()
      else search(query).firstOrNull { it.canBePlayed() }
    return hit?.let { intoSomethingToPlay(it) }
  }

  /**
   * An album or an artist becomes the first song the tree holds for it.
   *
   * Handed over as the collection, JS has to ask the server what is in it, and
   * a request made with the screen off never comes back. Handed a song, it
   * queues the collection from what it already has and plays, which is the
   * difference between an answer and silence. A track id carries the parent it
   * came from, so the whole album still gets queued behind it.
   */
  private fun intoSomethingToPlay(node: BrowseNode): BrowseNode =
    if (node.playable) node else nodes[node.id]?.firstOrNull { it.playable } ?: node

  private fun firstPlayableCollection(): BrowseNode? {
    for ((_, children) in nodes) {
      children.firstOrNull { it.id == "favorites" }?.let { return it }
    }
    for ((_, children) in nodes) {
      children.firstOrNull { it.canBePlayed() }?.let { return it }
    }
    return null
  }

  private fun BrowseNode.canBePlayed(): Boolean =
    playable ||
      id.startsWith("album:") ||
      id.startsWith("artist:") ||
      id.startsWith("playlist:") ||
      id == "favorites"

  /** A tree as it arrives: the nodes, whether it is only part of one, and the
   *  account it was built for. */
  private data class Snapshot(
    val nodes: Map<String, List<BrowseNode>>,
    val partial: Boolean,
    val profile: String?,
    val demandedAlbums: Set<String>,
  )

  private fun parse(json: String): Snapshot? = try {
    val root = JSONObject(json)
    val nodesObj = root.optJSONObject("nodes") ?: return null
    val map = HashMap<String, List<BrowseNode>>(nodesObj.length())
    val keys = nodesObj.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val arr = nodesObj.optJSONArray(k) ?: continue
      map[k] = parseList(arr)
    }
    Snapshot(
      nodes = map,
      partial = root.optBoolean("partial", false),
      profile = root.optString("profile").takeIf { it.isNotEmpty() },
      demandedAlbums = root.optJSONArray("demandedAlbums")?.let { arr ->
        (0 until arr.length()).map { arr.optString(it) }.filter { it.startsWith("album:") }.toSet()
      } ?: emptySet(),
    )
  } catch (_: Throwable) {
    null
  }

  private fun parseList(arr: JSONArray): List<BrowseNode> {
    val out = ArrayList<BrowseNode>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      out.add(
        BrowseNode(
          id = o.optString("id"),
          title = o.optString("title"),
          subtitle = o.optString("subtitle").takeIf { it.isNotEmpty() },
          artworkUrl = o.optString("artworkUrl").takeIf { it.isNotEmpty() },
          playable = o.optBoolean("playable", false),
          contentStyle = o.optString("contentStyle").takeIf { it.isNotEmpty() },
          mediaType = o.optString("mediaType").takeIf { it.isNotEmpty() },
          group = o.optString("group").takeIf { it.isNotEmpty() },
        )
      )
    }
    return out
  }
}
