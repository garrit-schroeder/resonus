/** Library: lists (with fixed access to Favorites) and artists. Settings. */
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  coverArtUrl,
  createPlaylist,
  getMusicFolders,
  getPlaylists,
  getStarred,
  type Playlist,
  COVER,
} from '@/api/data';
import { AlbumRow } from '@/components/AlbumRow';
import { ArtistRow } from '@/components/ArtistRow';
import { Cover } from '@/components/Cover';
import { useHistoryTimes } from '@/hooks/useHistoryTimes';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { FavoritesArt } from '@/components/FavoritesArt';
import { Message } from '@/components/Message';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { useBottomSheetAnim } from '@/hooks/useBottomSheetAnim';
import { albumsLabel, songsLabel, useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { useLastPlayed } from '@/store/lastPlayed';
import { useMediaMenu } from '@/store/mediaMenu';
import { usePins } from '@/store/pins';
import { useSettings, type LibrarySort } from '@/store/settings';
import { useAccent } from '@/hooks/useAccent';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, SHEET_MAX_WIDTH, spacing, themed, useTheme } from '@/theme';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useListPadding } from '@/hooks/useScreenSize';
import { columnsFor, useScreenSize } from '@/hooks/useScreenSize';
import { listPerf } from '@/lib/listPerf';
import { bump } from '@/lib/perfLog';
import { haptic } from '@/lib/haptics';

type Segment = 'playlists' | 'albums' | 'artists' | 'folders';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'playlists', label: 'Playlists' },
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
];

/** Extra "Folders" segment (directory browsing; Subsonic only). */
const FOLDERS_SEGMENT: { key: Segment; label: string } = { key: 'folders', label: 'Folders' };

// Library grid: the same gap as the rest of the grids.
/**
 * How wide a library card wants to be, in dp.
 *
 * Three across a phone, which is what this grid has always been, and the same
 * measure decides the rest: a tablet gets more of them rather than three
 * covers the size of a record sleeve (#131).
 */
const CARD_IDEAL = 180;
const GRID_GAP = spacing.sm;
/** The grid as it is right now: worked out while rendering, so a turn
 *  re-lays it out instead of keeping the width the app started at. */
function useGridMetrics(): { columns: number; card: number } {
  const { width } = useScreenSize();
  const columns = columnsFor(width, CARD_IDEAL, 3, 6);
  return {
    columns,
    card: (width - spacing.lg * 2 - GRID_GAP * (columns - 1)) / columns,
  };
}

// In grid mode, the Favorites access goes as the first card of the grid
// (in list it's the header). This sentinel id marks it within the data.
const FAVORITES_ID = '__favorites__';

// ── Spotify-style sort (Recent / Recently added / Alphabetical) ──

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: 'Recents',
  added: 'Recently added',
  alpha: 'Alphabetical',
};

/** Locale-aware name compare: right for accents/ñ (albums, artists). */
const byLocale = (a: string, b: string) => a.localeCompare(b);

/**
 * Case-insensitive code-point compare. Leading symbols sort before letters by
 * code point ("+" < "[" < a…), so playlists prefixed with "+" to pin them to
 * the top land there — matching Navidrome, Feishin and other clients.
 * localeCompare instead orders "[" before "+", burying the "+" playlists.
 */
function byCodepoint(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Sorts by the chosen criterion: alphabetical by name, or by descending score
 * (last play timestamp / added timestamp) with alphabetical tie-break — the
 * never-played ones end up last, in A-Z. `compare` picks the name ordering
 * (locale-aware by default; code point for playlists, see byCodepoint).
 */
function sortItems<T>(
  items: T[],
  sort: LibrarySort,
  name: (x: T) => string,
  score: (x: T) => number,
  compare: (a: string, b: string) => number = byLocale,
): T[] {
  // Keys computed once per item, not inside the comparator. A sort asks for
  // them about `2·n·log n` times, and `score` here parses a date or walks the
  // play history, so a couple of thousand favourites meant tens of thousands
  // of date parses on every render of the tab (#50).
  const keyed = items.map((item) => ({
    item,
    name: name(item),
    score: sort === 'alpha' ? 0 : score(item),
  }));
  const byName = (a: (typeof keyed)[number], b: (typeof keyed)[number]) =>
    compare(a.name, b.name);
  keyed.sort(sort === 'alpha' ? byName : (a, b) => b.score - a.score || byName(a, b));
  return keyed.map((k) => k.item);
}

/**
 * Normalizes for filtering: lowercase and without accents, so "Nino" finds
 * "Niño" and "cafe" finds "Café".
 */
function normQ(str: string): string {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Does any of the fields contain the (already normalized) query? */
function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  return fields.some((f) => f && normQ(f).includes(query));
}

/** "⇅ Recent" row under the segments; opens the sort sheet. */
function SortBar({ onPress }: { onPress: () => void }) {
  const t = useT();
  const sort = useSettings((s) => s.librarySort);
  return (
    <Pressable style={styles.sortBar} hitSlop={8} onPress={onPress}>
      <Ionicons name="swap-vertical" size={15} color={colors.textSecondary} />
      <Text style={styles.sortBarText}>{t(SORT_LABELS[sort])}</Text>
    </Pressable>
  );
}

function SortSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const sort = useSettings((s) => s.librarySort);
  const setSort = useSettings((s) => s.setLibrarySort);
  const { dismiss, pan, backdropStyle, sheetStyle, onSheetLayout } = useBottomSheetAnim(
    visible,
    onClose,
  );
  const close = () => dismiss(onClose);
  if (!visible) return null;
  return (
    <Modal transparent animationType="none" visible onRequestClose={close}>
      {/* Gestures inside an RN Modal need a root view of their own: the
          Modal renders in a native hierarchy outside the app's. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>
        {/* One drag around the whole sheet: what's in here never scrolls,
            so nothing else competes for the gesture. */}
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }, sheetStyle]}
            onLayout={onSheetLayout}
          >
            {/* Spotify-style grabber: the visual cue that the sheet can be
                dragged down to dismiss. */}
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>{t('Sort by')}</Text>
            {(Object.keys(SORT_LABELS) as LibrarySort[]).map((key) => {
              const active = key === sort;
              return (
                <Pressable
                  key={key}
                  style={({ pressed }) => [styles.sheetRow, pressed && { opacity: 0.6 }]}
                  onPress={() => {
                    setSort(key);
                    close();
                  }}
                >
                  <Text style={[styles.sheetRowText, active && { color: colors.accent }]}>
                    {t(SORT_LABELS[key])}
                  </Text>
                  {active ? (
                    <Ionicons name="checkmark" size={20} color={colors.accent} style={{ marginLeft: 'auto' }} />
                  ) : null}
                </Pressable>
              );
            })}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** Pinned first (in their pinned order), ignoring the chosen sort order. */
function withPins<T>(items: T[], key: (x: T) => string, pins: Record<string, number>): T[] {
  const pinned = items
    .filter((x) => pins[key(x)])
    .sort((a, b) => pins[key(a)] - pins[key(b)]);
  if (pinned.length === 0) return items;
  return [...pinned, ...items.filter((x) => !pins[key(x)])];
}

function FavoritesEntry({ grid }: { grid?: boolean }) {
  const canFetch = useAuthStore((s) => !!s.auth || s.offline);
  const t = useT();
  const lang = useSettings((s) => s.language);
  const { data } = useQuery({
    queryKey: ['starred'],
    queryFn: () => getStarred(),
    enabled: canFetch,
  });
  const count = data?.songs.length ?? 0;
  const { card } = useGridMetrics();

  if (grid) {
    return (
      <GridCard
        href="/favorites"
        art={<FavoritesArt size={card} />}
        title={t('Favorites')}
        subtitle={songsLabel(count, lang)}
      />
    );
  }

  return (
    <Link href="/favorites" asChild>
      <Pressable style={styles.row}>
        <FavoritesArt size={56} />
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle}>{t('Favorites')}</Text>
          <Text style={[styles.rowSub, styles.rowSubGap]}>{songsLabel(count, lang)}</Text>
        </View>
      </Pressable>
    </Link>
  );
}

function PlaylistsTab({ onNew, query }: { onNew?: () => void; query: string }) {
  const canFetch = useAuthStore((s) => !!s.auth || s.offline);
  const t = useT();
  const lang = useSettings((s) => s.language);
  const sort = useSettings((s) => s.librarySort);
  const times = useLastPlayed((s) => s.times);
  const pins = usePins((s) => s.pins);
  const openMenu = useMediaMenu((s) => s.open);
  const grid = useSettings((s) => s.libraryLayout) === 'grid';
  const bottomPad = useScreenBottomPadding();
  // Rows stop growing at a reading measure and centre themselves (#131).
  const listPad = useListPadding(spacing.lg);
  const { columns } = useGridMetrics();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['playlists'],
    queryFn: () => getPlaylists(),
    enabled: canFetch,
  });
  // Filtering and sorting are memoised, and the hook goes before the early
  // returns below because hooks cannot be conditional. Without this the whole
  // list was filtered and sorted again on every render of the tab, which
  // includes every keystroke in its search box (#50).
  const playlists = useMemo(
    () =>
      withPins(
        sortItems(
          (data ?? []).filter((p) => matches(query, p.name)),
          sort,
          (p) => p.name,
          sort === 'recent'
            ? (p) => times[`/playlist/${p.id}`] ?? 0
            : (p) => Date.parse(p.created ?? '') || 0,
          // Code point so "+"-prefixed playlists pin to the top like on the server.
          byCodepoint,
        ),
        (p) => `playlist:${p.id}`,
        pins,
      ),
    [data, query, sort, times, pins],
  );
  if (isLoading) return <Loader />;
  if (isError) return <Message text={t("Couldn't load playlists.")} onRetry={() => refetch()} />;
  // In grid, Favorites goes in as the first card (sentinel); in list it
  // remains the full-width header.
  const listData: Playlist[] = grid ? [{ id: FAVORITES_ID, name: '' }, ...playlists] : playlists;
  return (
    <FlatList
      key={grid ? `grid-${columns}` : 'list'}
      {...listPerf}
      // With the filter box open, a tap opens the row instead of only closing the keyboard.
      keyboardShouldPersistTaps="handled"
      {...gridListProps(grid, bottomPad, columns, listPad)}
      data={listData}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={colors.accent} />
      }
      ListHeaderComponent={grid ? undefined : <FavoritesEntry />}
      ListEmptyComponent={
        query ? (
          <NoResults query={query} />
        ) : (
          <EmptyState
            icon="list-outline"
            title={t('No playlists yet')}
            subtitle={t('Create your first playlist to get started.')}
            action={onNew ? { label: t('New playlist'), onPress: onNew } : undefined}
          />
        )
      }
      renderItem={({ item }: { item: Playlist }) =>
        item.id === FAVORITES_ID ? (
          <FavoritesEntry grid />
        ) : grid ? (
          <GridCard
            href={`/playlist/${item.id}`}
            uri={coverArtUrl(item.coverArt ?? item.id, COVER.card)}
            title={item.name}
            subtitle={songsLabel(item.songCount ?? 0, lang)}
            pinned={!!pins[`playlist:${item.id}`]}
            onLongPress={() => { haptic('light'); openMenu({ kind: 'playlist', playlist: item }); }}
          />
        ) : (
          <Link href={`/playlist/${item.id}`} asChild>
            <Pressable
              style={styles.row}
              onLongPress={() => { haptic('light'); openMenu({ kind: 'playlist', playlist: item }); }}
            >
              <Cover uri={coverArtUrl(item.coverArt ?? item.id, COVER.thumb)} size={56} />
              <View style={styles.rowInfo}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={styles.rowSubLine}>
                  {pins[`playlist:${item.id}`] ? (
                    <MaterialCommunityIcons name="pin" size={13} color={colors.accent} style={styles.pinIcon} />
                  ) : null}
                  <Text style={styles.rowSub}>{songsLabel(item.songCount ?? 0, lang)}</Text>
                </View>
              </View>
            </Pressable>
          </Link>
        )
      }
    />
  );
}

function ArtistsTab({ query }: { query: string }) {
  const canFetch = useAuthStore((s) => !!s.auth || s.offline);
  const t = useT();
  const lang = useSettings((s) => s.language);
  const sort = useSettings((s) => s.librarySort);
  const times = useLastPlayed((s) => s.times);
  const { byArtist } = useHistoryTimes();
  const grid = useSettings((s) => s.libraryLayout) === 'grid';
  const bottomPad = useScreenBottomPadding();
  const { columns } = useGridMetrics();
  const listPad = useListPadding(spacing.lg);
  // Only favorite artists (what's browseable is in Home).
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['starred'],
    queryFn: () => getStarred(),
    enabled: canFetch,
  });
  // See PlaylistsTab: memoised, and before the early returns.
  const artists = useMemo(
    () =>
      sortItems(
        (data?.artists ?? []).filter((a) => matches(query, a.name)),
        sort,
        (a) => a.name,
        sort === 'recent'
          ? (a) => Math.max(times[`/artist/${a.id}`] ?? 0, byArtist.get(a.id) ?? 0)
          : (a) => Date.parse(a.starred ?? '') || 0,
      ),
    [data, query, sort, times, byArtist],
  );
  if (isLoading) return <Loader />;
  if (isError) return <Message text={t("Couldn't load artists.")} onRetry={() => refetch()} />;
  return (
    <FlatList
      key={grid ? `grid-${columns}` : 'list'}
      {...listPerf}
      keyboardShouldPersistTaps="handled"
      {...gridListProps(grid, bottomPad, columns, listPad)}
      data={artists}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={colors.accent} />
      }
      renderItem={({ item }) =>
        grid ? (
          <GridCard
            href={`/artist/${item.id}`}
            uri={coverArtUrl(item.coverArt ?? item.id, COVER.card)}
            rounded
            title={item.name}
            subtitle={albumsLabel(item.albumCount ?? 0, lang)}
          />
        ) : (
          <ArtistRow artist={item} />
        )
      }
      ListEmptyComponent={
        query ? (
          <NoResults query={query} />
        ) : (
          <EmptyState
            icon="people-outline"
            title={t('No favorite artists')}
            subtitle={t('Star artists to see them here.')}
          />
        )
      }
    />
  );
}

/** "Folders" segment: lists libraries and opens their directory browser. */
/** Nothing matched the filter (as opposed to "you have none yet"). */
function NoResults({ query }: { query: string }) {
  const t = useT();
  return (
    <EmptyState
      icon="search-outline"
      title={t('No results')}
      subtitle={t('No results for “{q}”', { q: query })}
    />
  );
}

function FoldersTab() {
  const listPad = useListPadding(spacing.lg);
  const t = useT();
  const router = useRouter();
  const bottomPad = useScreenBottomPadding();
  const canFetch = useAuthStore((s) => !!s.auth);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['musicFolders'],
    queryFn: () => getMusicFolders(),
    enabled: canFetch,
  });
  if (isLoading) return <Loader />;
  if (isError) return <Message text={t("Couldn't load folders.")} onRetry={() => refetch()} />;
  // No declared libraries: a root entry that explores the entire tree.
  const folders = data && data.length > 0 ? data : [{ id: 'root', name: t('Music') }];
  return (
    <FlatList
      {...listPerf}
      contentContainerStyle={[
        styles.list,
        { paddingBottom: bottomPad, paddingHorizontal: listPad },
      ]}
      data={folders}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() =>
            router.push({
              pathname: '/browse/folder/[id]',
              params: { id: item.id, name: item.name, root: '1' },
            })
          }
        >
          <Ionicons name="folder" size={44} color={colors.accent} />
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
        </Pressable>
      )}
    />
  );
}

function AlbumsTab({ query }: { query: string }) {
  const canFetch = useAuthStore((s) => !!s.auth || s.offline);
  const t = useT();
  const sort = useSettings((s) => s.librarySort);
  const times = useLastPlayed((s) => s.times);
  const pins = usePins((s) => s.pins);
  const { byAlbum } = useHistoryTimes();
  const openMenu = useMediaMenu((s) => s.open);
  const grid = useSettings((s) => s.libraryLayout) === 'grid';
  const bottomPad = useScreenBottomPadding();
  const { columns } = useGridMetrics();
  const listPad = useListPadding(spacing.lg);
  // Only favorite albums (what's browseable is in Home).
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['starred'],
    queryFn: () => getStarred(),
    enabled: canFetch,
  });
  // See PlaylistsTab: memoised, and before the early returns.
  const albums = useMemo(
    () =>
      withPins(
        sortItems(
          // Albums also match by artist: looking for "radiohead" in your
          // favourites should find their records, not just an album literally
          // called that.
          (data?.albums ?? []).filter((a) => matches(query, a.name, a.artist)),
          sort,
          (a) => a.name,
          sort === 'recent'
            ? (a) => Math.max(times[`/album/${a.id}`] ?? 0, byAlbum.get(a.id) ?? 0)
            : (a) => Date.parse(a.starred ?? '') || 0,
        ),
        (a) => `album:${a.id}`,
        pins,
      ),
    [data, query, sort, times, byAlbum, pins],
  );
  if (isLoading) return <Loader />;
  if (isError) return <Message text={t("Couldn't load albums.")} onRetry={() => refetch()} />;
  return (
    <FlatList
      key={grid ? `grid-${columns}` : 'list'}
      {...listPerf}
      keyboardShouldPersistTaps="handled"
      {...gridListProps(grid, bottomPad, columns, listPad)}
      data={albums}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={colors.accent} />
      }
      renderItem={({ item }) =>
        grid ? (
          <GridCard
            href={`/album/${item.id}`}
            uri={coverArtUrl(item.coverArt ?? item.id, COVER.card)}
            title={item.name}
            subtitle={item.artist}
            pinned={!!pins[`album:${item.id}`]}
            onLongPress={() => { haptic('light'); openMenu({ kind: 'album', album: item }); }}
          />
        ) : (
          <AlbumRow album={item} pinned={!!pins[`album:${item.id}`]} />
        )
      }
      ListEmptyComponent={
        query ? (
          <NoResults query={query} />
        ) : (
          <EmptyState
            icon="albums-outline"
            title={t('No favorite albums')}
            subtitle={t('Star albums to see them here.')}
          />
        )
      }
    />
  );
}

function Loader() {
  return <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />;
}

/** Button to toggle list/grid; shows the current mode's icon. */
function LayoutToggle() {
  const t = useT();
  const layout = useSettings((s) => s.libraryLayout);
  const setLayout = useSettings((s) => s.setLibraryLayout);
  const grid = layout === 'grid';
  return (
    <Pressable
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={grid ? t('List view') : t('Grid view')}
      onPress={() => setLayout(grid ? 'list' : 'grid')}
    >
      <Ionicons name={grid ? 'list' : 'grid-outline'} size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

/** Grid card (album/list/artist and the Favorites access). */
function GridCard({
  href,
  uri,
  art,
  rounded,
  title,
  subtitle,
  pinned,
  onLongPress,
}: {
  href: string;
  uri?: string;
  /** Alternative cover (e.g. the Favorites tile). */
  art?: ReactNode;
  rounded?: boolean;
  title: string;
  subtitle?: string;
  pinned?: boolean;
  onLongPress?: () => void;
}) {
  const { card } = useGridMetrics();
  return (
    <Link href={href} asChild>
      <Pressable
        style={StyleSheet.flatten([styles.card, { width: card }, rounded && styles.cardCentered])}
        onLongPress={onLongPress}
      >
        {art ?? <Cover uri={uri} size={card} rounded={rounded} />}
        <Text style={[styles.cardTitle, rounded && styles.centerText]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <View style={styles.cardSubLine}>
            {pinned ? (
              <MaterialCommunityIcons name="pin" size={12} color={colors.accent} style={styles.pinIcon} />
            ) : null}
            <Text style={styles.cardSub} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Link>
  );
}

/**
 * FlatList props by layout. Additionally `key={grid...}` must be passed
 * directly on each list to force remounting: FlatList doesn't support hot-
 * changing `numColumns` (and `key` can't go in a spread).
 */
function gridListProps(grid: boolean, bottomPad: number, columns: number, listPad: number) {
  return grid
    ? {
        numColumns: columns,
        columnWrapperStyle: { gap: GRID_GAP },
        contentContainerStyle: [styles.gridList, { paddingBottom: bottomPad }],
      }
    : {
        contentContainerStyle: [
          styles.list,
          { paddingBottom: bottomPad, paddingHorizontal: listPad },
        ],
      };
}

export default function LibraryScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  // Counted, to answer whether a tab you have visited keeps working
  // afterwards: they stay mounted once opened, and freezing them is
  // supposed to stop them rendering while they are not on screen. If this
  // climbs while you are somewhere else, it does not.
  bump('render · library');
  const t = useT();
  const accent = useAccent();
  useSettings((s) => s.appFont); // re-render when font changes
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const queryClient = useQueryClient();
  const toast = useToast((s) => s.show);
  const [segment, setSegment] = useState<Segment>('playlists');
  // Rows are centred on a wide screen and a grid is not, so the header lines
  // up with whichever is underneath it.
  const listPad = useListPadding(spacing.lg);
  const headerPad = useSettings((s) => s.libraryLayout) === 'grid' ? spacing.lg : listPad;
  const [creating, setCreating] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // Filter over what the Library already has in memory (your favourites and
  // your lists): no server round-trip, unlike browsing the whole collection.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filter = normQ(query.trim());

  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    setQuery('');
    setSearchOpen(false);
  }, []);

  // Leaving the screen puts the bar away: going to another tab, or opening one
  // of the results and coming back. The X was the only way out of it, which
  // meant a filter typed once stayed on the Library for the rest of the
  // session.
  useFocusEffect(useCallback(() => closeSearch, [closeSearch]));

  // And Back closes it before it leaves, the way Android expects. Only while
  // the bar is open, so the tab keeps its own behaviour the rest of the time.
  // With the keyboard up the system eats the first press to lower it and this
  // never sees it; that press is the keyboard's, not ours to take.
  useEffect(() => {
    if (!searchOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searchOpen, closeSearch]);

  function toggleSearch() {
    if (searchOpen) {
      closeSearch();
    } else {
      // The bar opens focused and typing, which is what tapping a magnifier
      // asks for. `autoFocus` on the input rather than a `focus()` from here:
      // the input mounts with the render this schedules, and Android decides
      // whether to raise the keyboard when the field is attached to the
      // window, which is later. Asking before that only moved the caret, and
      // the bar sat there needing a second tap to type in.
      setSearchOpen(true);
    }
  }

  // "Folders" only with a Subsonic server (Jellyfin doesn't browse directories;
  // offline doesn't apply) and with the setting enabled (hidden by default).
  const showFolderBrowser = useSettings((s) => s.showFolderBrowser);
  const foldersEnabled =
    showFolderBrowser && !offline && !!auth && auth.serverType !== 'jellyfin';
  const visibleSegments = foldersEnabled ? [...SEGMENTS, FOLDERS_SEGMENT] : SEGMENTS;
  const activeSegment = segment === 'folders' && !foldersEnabled ? 'playlists' : segment;

  async function onCreate(name: string) {
    setCreating(false);
    if (!auth && !offline) return;
    try {
      await createPlaylist(name);
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      toast(t('Playlist created'));
    } catch {
      toast(t("Couldn't create the playlist"));
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* The screen's own chrome follows what it is over: with rows, it lines
          up with the centred column; with a grid, the grid fills the width and
          so does this (#131). */}
      <View style={[styles.header, { paddingHorizontal: headerPad }]}>
        <Text style={styles.heading}>{t('Library')}</Text>
        <View style={styles.headerActions}>
          <OfflineIndicator />
          {/* Folders are a handful of server roots: nothing to filter there. */}
          {activeSegment === 'folders' ? null : (
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={searchOpen ? t('Close') : t('Search')}
              onPress={toggleSearch}
            >
              <Ionicons
                name={searchOpen ? 'close' : 'search'}
                size={24}
                color={searchOpen ? colors.accent : colors.text}
              />
            </Pressable>
          )}
          <Pressable
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('New playlist')}
            onPress={() => setCreating(true)}
          >
            <Ionicons name="add" size={28} color={colors.text} />
          </Pressable>
        </View>
      </View>

      {/* Hidden on Folders along with its button, so the bar can't be left
          open with no way to close it. Its text survives: coming back to the
          other segments finds the filter as you left it, which is the point of
          filtering the same word across lists, albums and artists. */}
      {searchOpen && activeSegment !== 'folders' ? (
        <View style={styles.searchRow}>
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('Search')}
              placeholderTextColor={colors.textMuted}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
            />
            {query.length > 0 ? (
              <Pressable
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('Clear')}
                onPress={() => setQuery('')}
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <Dialog
        visible={creating}
        title={t('New playlist')}
        input={{ placeholder: t('Playlist name') }}
        confirmLabel={t('Create')}
        onCancel={() => setCreating(false)}
        onConfirm={onCreate}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.segments}
        contentContainerStyle={[styles.segmentsContent, { paddingHorizontal: headerPad }]}
      >
        {visibleSegments.map((s) => {
          const active = s.key === activeSegment;
          return (
            <Pressable
              key={s.key}
              style={[styles.segment, active && { backgroundColor: accent }]}
              onPress={() => setSegment(s.key)}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {t(s.label)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Sort/layout controls don't apply to Folders. */}
      {activeSegment === 'folders' ? null : (
        <>
          <View style={[styles.controls, { paddingHorizontal: headerPad }]}>
            <SortBar onPress={() => setSortOpen(true)} />
            <LayoutToggle />
          </View>
          <SortSheet visible={sortOpen} onClose={() => setSortOpen(false)} />
        </>
      )}

      <View style={{ flex: 1 }}>
        {activeSegment === 'playlists' ? (
          <PlaylistsTab onNew={() => setCreating(true)} query={filter} />
        ) : activeSegment === 'albums' ? (
          <AlbumsTab query={filter} />
        ) : activeSegment === 'artists' ? (
          <ArtistsTab query={filter} />
        ) : (
          <FoldersTab />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  heading: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  segments: {
    flexGrow: 0,
    paddingBottom: spacing.md,
  },
  segmentsContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  segment: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    backgroundColor: colors.surfaceHighlight,
  },
  segmentText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  segmentTextActive: { color: colors.onAccent },
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    backgroundColor: colors.surfaceHighlight,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: fontSize.md, paddingVertical: 0 },
  list: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  gridList: {
    paddingHorizontal: spacing.lg,
    gap: spacing.lg,
  },
  card: { gap: spacing.xs },
  cardCentered: { alignItems: 'center' },
  cardTitle: { color: colors.text, fontSize: fontSize.xs, fontWeight: '600', marginTop: spacing.xs },
  centerText: { textAlign: 'center' },
  cardSub: { color: colors.textSecondary, fontSize: fontSize.xs },
  cardSubLine: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowInfo: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: fontSize.xs },
  rowSubGap: { marginTop: 2 },
  // Subtitle with room for the pinned icon.
  rowSubLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  // The MCI pin comes vertical; rotated 45° it looks like Spotify's.
  pinIcon: { transform: [{ rotate: '45deg' }] },
  // Control row: sort on the left ("⇅ Recent"), toggle list/grid on the right.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  // Spotify-style sort row ("⇅ Recent") and its bottom sheet.
  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  sortBarText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.backdrop },
  sheet: {
    position: 'absolute',
    bottom: 0,
    // Centred and no wider than a sheet wants to be (#131).
    alignSelf: 'center',
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    // Smaller than the old spacing.lg because the grabber below already brings
    // its own margin: together they add up to the same top gap as before.
    paddingTop: spacing.sm,
  },
  // Spotify's little handle. Its only job is to advertise the drag gesture, so
  // it stays discreet: it must read as an affordance, not as a control.
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    opacity: 0.5,
    marginBottom: spacing.md,
  },
  sheetTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  sheetRowText: { color: colors.text, fontSize: fontSize.md },
}));
