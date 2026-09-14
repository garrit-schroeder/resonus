/**
 * Builds the Android Auto browse tree from the data layer (online Subsonic
 * or offline local, interchangeably) and resolves what to play when the car
 * taps an item.
 *
 * The tree is a flat parentId → children map pushed in full to the native
 * module (`setNodes`), because the native service doesn't fetch: it reads
 * from the cached tree. That's why we prefetch each album/playlist's tracks.
 *
 * Adapted from the wavio pattern (github.com/Joel-Mercier/wavio, MIT).
 */
import * as data from '@/api/data';
import { type Album, type Artist, type Playlist, type Song } from '@/api/subsonic';
import { songsLabel, tg } from '@/i18n';
import { queryClient } from '@/lib/query';
import { profileScopeId } from '@/store/auth';
import { useLastPlayed } from '@/store/lastPlayed';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { type CarNode, type CarTree } from './carAuto';

const ROOT = 'root';
const HOME_SIZE = 15;

/** An album's tracklist, shared with the album screen's own query rather than
 *  fetched a second time for the car. */
function albumDetail(id: string): Promise<{ songs: Song[] }> {
  return queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => data.getAlbum(id) });
}

/** The same, for a playlist and the playlist screen's query. */
function playlistDetail(id: string): Promise<{ songs: Song[] }> {
  return queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => data.getPlaylist(id) });
}
const CONCURRENCY = 4;
/**
 * Ceilings for what gets fetched ahead of a car that may never be plugged in.
 * Everything above them still appears in the browse tree; what it doesn't have
 * yet is the list of songs inside, which arrives on the next rebuild.
 */
const MAX_PREFETCH_ALBUMS = 40;
const MAX_PREFETCH_ARTISTS = 15;
const MAX_PREFETCH_PLAYLISTS = 20;
const MAX_ARTIST_ALBUMS = 5;

// ── Snapshot to resolve taps without refetching data ─────────────────────────
const songById = new Map<string, Song>();
/** parentId → track mediaIds (in order) to queue the collection on tap. */
const parentTracks = new Map<string, string[]>();
/** Collection id → what it is called, to name the source a car started. */
const nodeTitles = new Map<string, string>();
/** The account these three were filled from. They are thrown away when it
 *  changes and only then: a rebuild of the lists alone knows nothing about
 *  any album's songs, and emptying them there left a tap in the car with no
 *  way to tell which collection the song it was handed belongs to. */
let mapsProfile: string | null = null;

/** Runs `fn` over `items` with at most `n` in parallel (avoids 429). */
async function mapConcurrent<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

// Track mediaId embeds its parent to know which collection to queue.
function trackMediaId(parentId: string, songId: string): string {
  return `track|${parentId}|${songId}`;
}

function art(id: string | undefined): string | undefined {
  return data.coverArtUrl(id, data.COVER.card);
}

/**
 * One of our own icons for a row that leads somewhere rather than to a song.
 * The native side turns this into a resource uri of the running package, and
 * the car tints the white drawable to whatever its theme is (`VD-2`). Without
 * one, a category row is bare text, and telling four of those apart at a
 * glance means reading them.
 */
function icon(name: string): string {
  return `res://${name}`;
}

function songNode(s: Song, parentId: string): CarNode {
  songById.set(s.id, s);
  return {
    id: trackMediaId(parentId, s.id),
    title: s.title || tg('Unknown title'),
    subtitle: s.artist,
    artworkUrl: art(s.coverArt ?? s.albumId),
    playable: true,
  };
}

function albumNode(a: Album): CarNode {
  nodeTitles.set(`album:${a.id}`, a.name);
  return {
    id: `album:${a.id}`,
    title: a.name,
    subtitle: a.artist,
    artworkUrl: art(a.coverArt ?? a.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'album',
  };
}

function playlistNode(p: Playlist): CarNode {
  nodeTitles.set(`playlist:${p.id}`, p.name);
  return {
    id: `playlist:${p.id}`,
    title: p.name,
    // Who it belongs to, which is what tells two lists of the same name apart
    // on a shared server. Falls back to the length for servers that send no
    // owner at all.
    subtitle:
      p.owner ||
      (p.songCount != null ? songsLabel(p.songCount, useSettings.getState().language) : undefined),
    artworkUrl: art(p.coverArt ?? p.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'playlist',
  };
}

function artistNode(a: Artist): CarNode {
  nodeTitles.set(`artist:${a.id}`, a.name);
  return {
    id: `artist:${a.id}`,
    title: a.name,
    artworkUrl: art(a.coverArt ?? a.id),
    playable: false,
    contentStyle: 'list',
    mediaType: 'artist',
  };
}

/**
 * Newest played first, and whatever was never played keeps the order the
 * server sent. The car's lists are long and what you put on last week is a
 * better guess at what you want now than wherever the alphabet left it.
 */
function byLastPlayed<T>(items: T[], href: (item: T) => string): T[] {
  const { times } = useLastPlayed.getState();
  return items
    .map((item, i) => ({ item, i, ts: times[href(item)] ?? 0 }))
    .sort((a, b) => b.ts - a.ts || a.i - b.i)
    .map((x) => x.item);
}

/** How many go in the Recents tab. A screenful is three rows of five. */
const RECENTS_SIZE = 20;

/** What each kind of source is called under its tile. */
const KIND_LABEL = { album: 'Album', artist: 'Artist', playlist: 'Playlist' } as const;

/**
 * The Recents tab: what was last played, newest first, whatever kind it is.
 *
 * Read straight from the store the Library's "Recents" order and Home's grid
 * already use, so it needs nothing from the server: the name was written down
 * when it played and the cover comes from the id inside the href. Songs are
 * left out — what gets played again is the album or the playlist it came from,
 * and a car full of single tracks is a worse thing to steer through.
 */
function recentNodes(): CarNode[] {
  const { times, names } = useLastPlayed.getState();
  const nodes: CarNode[] = [];
  for (const [href] of Object.entries(times).sort((a, b) => b[1] - a[1])) {
    if (nodes.length >= RECENTS_SIZE) break;
    const [, kind, id] = href.split('/');
    const name = names[href];
    if (!name || !id || !(kind in KIND_LABEL)) continue;
    const type = kind as keyof typeof KIND_LABEL;
    nodeTitles.set(`${type}:${id}`, name);
    nodes.push({
      id: `${type}:${id}`,
      title: name,
      subtitle: tg(KIND_LABEL[type]),
      artworkUrl: art(id),
      playable: false,
      contentStyle: 'list',
      mediaType: type,
    });
  }
  return nodes;
}

/**
 * Home's shelves. Their covers are shown straight, under a heading, instead of
 * behind a folder each: a driver reaching for music should be looking at the
 * records, not at the names of two drawers.
 *
 * Titles are resolved inside buildBrowseTree (i18n is loaded by then).
 */
const HOME_SHELVES: { type: 'newest' | 'frequent'; titleKey: string }[] = [
  { type: 'newest', titleKey: 'Recently added' },
  { type: 'frequent', titleKey: 'Most played' },
];

/** How many covers each shelf puts on Home. The tab is scrolled, not read. */
const HOME_SHELF_SIZE = 10;

/** Plays songs picked at random, resolved only when it is tapped. */
const SHUFFLE_ID = 'shuffle:all';
/** How many it queues. Enough for a drive without asking again. */
const SHUFFLE_SONGS = 100;

/**
 * The whole browse tree, or only its lists.
 *
 * Filling it in means asking the server for the songs of every album on the
 * shelves and every favourite, plus each favourite artist's albums and their
 * songs. That was happening within a second of every launch, whether or not a
 * car was ever going to be plugged in, and it is dozens of requests before the
 * app has finished opening (#50). The lists themselves are nearly free: they
 * come from the same queries the app has already made.
 *
 * So the lists go up straight away and the songs follow later, once the app is
 * done starting or as soon as a car is plugged in. A tree without the songs is
 * marked `partial` and the native side lays it over the one it already has,
 * rather than taking it for the whole library: it was replacing the songs of
 * every album with nothing, in memory and in the snapshot it keeps for a car
 * that starts the service on its own.
 */
export async function buildBrowseTree(deep = true): Promise<CarTree> {
  const profile = profileScopeId();
  // A full build replaces what it knows; a partial one adds to it. What is
  // dropped either way is another account's, which nothing here can resolve.
  if (deep || profile !== mapsProfile) {
    songById.clear();
    parentTracks.clear();
    nodeTitles.clear();
  }
  mapsProfile = profile;
  const tree: Record<string, CarNode[]> = {};

  // Root: the four tabs Android Auto draws, and no more than four. What goes
  // inside each one is still being decided, so they are empty on purpose; the
  // collections below are built all the same and are waiting to be hung off
  // whichever tab ends up owning them.
  tree[ROOT] = [
    { id: 'tab:home', title: tg('Home'), playable: false, contentStyle: 'list', artworkUrl: icon('ic_car_home') },
    { id: 'tab:recents', title: tg('Recents'), playable: false, contentStyle: 'grid', artworkUrl: icon('ic_car_recent') },
    { id: 'tab:library', title: tg('Library'), playable: false, contentStyle: 'list', artworkUrl: icon('ic_car_library') },
  ];
  tree['tab:home'] = [];
  tree['tab:recents'] = recentNodes();
  // Library: two ways in, each opening onto a grid of covers. A list of two
  // rows is cheap to read at a glance, which a grid of two tiles would not be.
  tree['tab:library'] = [
    { id: 'lib:playlists', title: tg('Playlists'), playable: false, contentStyle: 'grid', artworkUrl: icon('ic_car_playlists') },
    { id: 'lib:albums', title: tg('Albums'), playable: false, contentStyle: 'grid', artworkUrl: icon('ic_car_albums') },
  ];

  // Which albums get their songs fetched, in the order they deserve them. The
  // cap further down cuts the tail of this, and it was cutting the wrong end:
  // the starred albums went in last, behind up to fifty ids from the recents
  // and the shelves, so the one grid Library opens onto was the one whose
  // albums opened onto nothing.
  //
  // Recents lead all the same: what was played last is the likeliest thing to
  // be tapped again.
  const albumIds = new Set<string>(
    tree['tab:recents'].filter((n) => n.mediaType === 'album').map((n) => n.id.slice('album:'.length)),
  );

  // Home's shelves. Through the query cache, with the keys the screens use:
  // Home asks for these very lists, and the car was asking again for its own
  // copy on every launch. Whoever gets there first pays; the other reads it.
  const shelves = await Promise.all(
    HOME_SHELVES.map(async (s) => {
      const albums = await queryClient
        .fetchQuery({
          queryKey: ['albumList', s.type],
          queryFn: () => data.getAlbumList(s.type, HOME_SIZE),
        })
        .catch(() => [] as Album[]);
      return { title: tg(s.titleKey), albums: albums.slice(0, HOME_SHELF_SIZE) };
    }),
  );

  // What the tabs land on: favourite songs, playlists, starred albums and
  // starred artists. Folders are left out, as they were before: a handful of
  // server roots is nothing to hand a driver.
  const [starred, playlists] = await Promise.all([
    queryClient
      .fetchQuery({ queryKey: ['starred'], queryFn: () => data.getStarred() })
      .catch(() => ({ songs: [] as Song[], albums: [] as Album[], artists: [] as Artist[] })),
    // The same query the Library and the Home grid ask for: in the car it is
    // free, since by the time this runs somebody has usually paid for it.
    queryClient
      .fetchQuery({ queryKey: ['playlists'], queryFn: () => data.getPlaylists() })
      .catch(() => [] as Playlist[]),
  ]);

  // Favourites lead the playlists: they are the one list nobody made and
  // everybody plays, and on a phone they sit above them too.
  tree['lib:playlists'] = [
    {
      id: 'favorites',
      title: tg('Favorites'),
      subtitle: songsLabel(starred.songs.length, useSettings.getState().language),
      artworkUrl: icon('ic_car_favorites'),
      playable: false,
      contentStyle: 'list',
      mediaType: 'playlist',
    },
    ...byLastPlayed(playlists, (p) => `/playlist/${p.id}`).map(playlistNode),
  ];

  tree['favorites'] = starred.songs.map((s) => songNode(s, 'favorites'));
  parentTracks.set('favorites', tree['favorites'].map((n) => n.id));

  const starredAlbums = byLastPlayed(starred.albums, (a) => `/album/${a.id}`);
  tree['lib:albums'] = starredAlbums.map(albumNode);
  // Behind the recents and ahead of the shelves, in the order the grid shows
  // them. And of a shelf only what it shows, not the whole list it was cut
  // from: the songs of five albums nobody can see cost five albums somebody
  // can.
  starredAlbums.forEach((a) => albumIds.add(a.id));
  shelves.forEach((shelf) => shelf.albums.forEach((a) => albumIds.add(a.id)));

  tree['lib:artists'] = starred.artists.map(artistNode);

  // Home. Two things that need no choosing, and then the records themselves.
  // Shuffle leads because it is the answer to the only question anyone asks
  // with the engine running, and it plays on the tap: it is a leaf, not a
  // folder, and nothing is fetched for it until somebody presses it.
  tree['tab:home'] = [
    {
      id: SHUFFLE_ID,
      title: tg('Shuffle'),
      artworkUrl: icon('ic_car_shuffle'),
      playable: true,
    },
    {
      id: 'favorites',
      title: tg('Favorites'),
      subtitle: songsLabel(starred.songs.length, useSettings.getState().language),
      artworkUrl: icon('ic_car_favorites'),
      playable: false,
      contentStyle: 'list',
      mediaType: 'playlist',
    },
    ...shelves.flatMap((shelf) =>
      shelf.albums.map((a) => ({ ...albumNode(a), group: shelf.title })),
    ),
  ];

  // Marked for what it is: the lists, and none of the songs inside them. The
  // native side lays it over the tree it already has rather than taking it for
  // the whole library.
  if (!deep) return { nodes: tree, partial: true, profile };

  // The songs of each playlist, so they can be browsed and not only played
  // whole. Capped like everything else here: a car that is never plugged in
  // should not cost a request per playlist on every launch (#50). The cap
  // follows the order they are shown in, so what it pays for is what a driver
  // sees first and not whatever the server happened to send first.
  await mapConcurrent(
    byLastPlayed(playlists, (p) => `/playlist/${p.id}`)
      .slice(0, MAX_PREFETCH_PLAYLISTS)
      .map((p) => p.id),
    CONCURRENCY,
    async (id) => {
      const parent = `playlist:${id}`;
      try {
        const { songs } = await playlistDetail(id);
        tree[parent] = songs.map((s) => songNode(s, parent));
        parentTracks.set(parent, tree[parent].map((n) => n.id));
      } catch {
        tree[parent] = [];
      }
    },
  );

  // Prefetch songs for each album (to browse them in the car), up to a point.
  // Measured on a real account: fifty eight favourite artists meant six
  // hundred and forty four album requests in a single minute, plus their top
  // songs, every time the app opened. What a car needs at hand is the top of
  // each list; the rest can be empty until someone asks for it (#50).
  await mapConcurrent(Array.from(albumIds).slice(0, MAX_PREFETCH_ALBUMS), CONCURRENCY, async (id) => {
    try {
      const { songs } = await albumDetail(id);
      const parent = `album:${id}`;
      tree[parent] = songs.map((s) => songNode(s, parent));
      parentTracks.set(parent, tree[parent].map((n) => n.id));
    } catch {
      tree[`album:${id}`] = [];
    }
  });

  // Prefetch for starred artists: top songs + albums (and their tracks).
  await mapConcurrent(starred.artists.slice(0, MAX_PREFETCH_ARTISTS).map((a) => a.id), CONCURRENCY, async (id) => {
    try {
      const { artist, albums } = await data.getArtist(id);
      const top = artist.name
        ? await data.getTopSongs(artist.name, 10, id).catch(() => [] as Song[])
        : [];
      const parent = `artist:${id}`;
      const children: CarNode[] = [...top.map((s) => songNode(s, parent)), ...albums.map(albumNode)];
      tree[parent] = children;
      parentTracks.set(parent, children.filter((n) => n.playable).map((n) => n.id));
      for (const a of albums.slice(0, MAX_ARTIST_ALBUMS)) {
        const ap = `album:${a.id}`;
        if (!tree[ap]) {
          try {
            const { songs } = await albumDetail(a.id);
            tree[ap] = songs.map((s) => songNode(s, ap));
            parentTracks.set(ap, tree[ap].map((n) => n.id));
          } catch {
            tree[ap] = [];
          }
        }
      }
    } catch {
      tree[`artist:${id}`] = [];
    }
  });

  return { nodes: tree, profile };
}

// ── Playback resolution on car tap ───────────────────────────────────────────

function songIdFromTrackMediaId(mediaId: string): string {
  // format: track|<parentId>|<songId>
  return mediaId.split('|').slice(2).join('|');
}

/**
 * Where a car started playing from, in the app's own terms: the href of the
 * screen that collection has on the phone, and what it is called.
 *
 * Handed to `playQueue`, which is what writes the source down as recently
 * played. Without it a car left no trace at all: the Recents tab is built out
 * of exactly that store, so for anyone who only ever plays from the car it
 * stayed empty no matter how much they listened.
 */
function sourceOf(collectionId: string | undefined): [string, string] | [] {
  if (!collectionId) return [];
  if (collectionId === 'favorites') return [tg('Favorites'), '/favorites'];
  const [prefix, ...rest] = collectionId.split(':');
  const id = rest.join(':');
  if (!id || (prefix !== 'album' && prefix !== 'playlist' && prefix !== 'artist')) return [];
  return [nodeTitles.get(collectionId) ?? '', `/${prefix}/${id}`];
}

/**
 * Handles a car tap: if it's a track within a collection, queues the whole
 * collection starting from the tapped one; if it's an album/playlist/artist/favorites,
 * plays everything.
 */
export async function handleBrowsePlay(mediaId: string, parentId?: string): Promise<void> {
  const store = usePlayerStore.getState();

  // Asked for only now, which is the point of it: a shelf of random albums
  // would have to be fetched on every rebuild to sit there unplayed. No source
  // href goes with it, because there is no screen to go back to and a handful
  // of songs picked at random is not a thing to list among the recents.
  if (mediaId === SHUFFLE_ID) {
    const songs = await data.getRandomSongs(SHUFFLE_SONGS).catch(() => [] as Song[]);
    if (songs.length > 0) await store.playQueue(songs, 0, tg('Shuffle'));
    return;
  }

  if (mediaId.startsWith('track|')) {
    const parts = mediaId.split('|');
    const parent = parts[1] || parentId;
    const songId = parts.slice(2).join('|');
    const ids = parent ? parentTracks.get(parent) : undefined;
    if (ids && ids.length > 0) {
      const songs = ids
        .map((id) => songById.get(songIdFromTrackMediaId(id)))
        .filter((s): s is Song => !!s);
      const startIndex = Math.max(0, ids.indexOf(mediaId));
      if (songs.length > 0) {
        const [name, href] = sourceOf(parent);
        await store.playQueue(songs, Math.min(startIndex, songs.length - 1), name, href);
        return;
      }
    }
    const single = songById.get(songId);
    if (single) await store.playQueue([single], 0);
    return;
  }

  const [prefix, ...rest] = mediaId.split(':');
  const id = rest.join(':');
  let songs: Song[] = [];
  try {
    if (prefix === 'album') songs = (await albumDetail(id)).songs;
    else if (prefix === 'playlist') songs = (await playlistDetail(id)).songs;
    else if (prefix === 'favorites') songs = (await data.getStarred()).songs;
    else if (prefix === 'artist') {
      const { artist } = await data.getArtist(id);
      songs = artist.name ? await data.getTopSongs(artist.name, 20, id) : [];
    }
  } catch {
    songs = [];
  }
  if (songs.length > 0) {
    const [name, href] = sourceOf(mediaId);
    await store.playQueue(songs, 0, name, href);
  }
}
