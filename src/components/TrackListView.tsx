/**
 * Spotify-style header (dominant color gradient + cover that fades on scroll
 * and a collapsing fixed bar) and the song list. Shared by album and playlist
 * screens.
 */
import Icon from '@/components/Icon';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  type FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
// The list must use gesture-handler so the row swipe-to-queue doesn't fight
// the vertical scroll (with RN's FlatList the gesture is flaky).
import {
  FlatList as GHFlatList,
  Gesture,
  GestureDetector,
  type GestureType,
} from 'react-native-gesture-handler';
import ReorderableList, { type ReorderableListReorderEvent } from 'react-native-reorderable-list';

import { type Song, type StarType } from '@/api/subsonic';
import { useCoverTint } from '@/hooks/useDominantColor';
import { useInsets } from '@/hooks/useInsets';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { centredPadding, useScreenSize } from '@/hooks/useScreenSize';
import { useSelectionMenu } from '@/hooks/useSelectionMenu';
import { useT } from '@/i18n';
import { artistTargets } from '@/lib/artistNav';
import { easedFade } from '@/lib/fade';
import { haptic } from '@/lib/haptics';
import { listPerf } from '@/lib/listPerf';
import { useArtistPicker } from '@/store/artistPicker';
import { usePlayerStore } from '@/store/player';
import { colors, fontSize, radius, restyled, spacing, themed, tracking } from '@/theme';
import { motion } from '@/theme/motion';
import { BackChevron } from './BackChevron';
import { TopBarBackground } from './BarBlur';
import { Cover, useCoverRadius } from './Cover';
import { ExplicitBadge, useExplicitBadge } from './ExplicitBadge';
import { FavoriteButton } from './FavoriteButton';
import { SelectionBar, type SelectionAction } from './SelectionBar';
import { DragTrackRow, TrackRow } from './TrackRow';

/**
 * The cover across the top of an album or a playlist.
 *
 * A share of the width, capped, and measured while rendering rather than once
 * when the file was imported: turning the phone used to leave it at the size
 * it had when the app started. The height matters as much as the width on a
 * screen lying on its side, where 250 points of picture is most of the page
 * and the tracklist is what people came for (#131).
 */
function coverSize(width: number, height: number): number {
  return Math.round(Math.min(width * 0.58, height * 0.4, 250));
}
export const TOPBAR_H = 48;
/** The round play button in the header: its size, and the share of it the
 *  bar holds once it reaches the bar (half inside it, half below its edge). */
const PLAY_SIZE = 56;
/** Height of the hidden search bar ("Find in playlist" Spotify style),
 *  including the separation gap from the cover. */
const SEARCH_H = 72;
/** How far the wide cover's gradient runs: from the picture's lower edge,
 *  through the title and the buttons, arriving at the page's own colour
 *  around the play button ("circa", as the order asked for it). */
const WIDE_GRADIENT_H = 240;
/** How far above the content the accent reaches: iOS reveals that strip on a
 *  pull-down bounce, and without it the page background would flash where the
 *  cover's own colour belongs. Tall enough for any pull; one view, no paint
 *  cost at rest, where it hangs off screen. */
const OVERSCROLL_H = 1200;
/** Lines of the description shown before "Show more". */
const DESCRIPTION_LINES = 2;

/**
 * The list, with its scroll wired straight to what the scroll animates.
 *
 * The cover fading, the bar coming in and the gradient following the scroll all
 * hang off the scroll position, and every frame of them used to go through JS:
 * the list moved natively while they waited behind whatever else the thread was
 * doing. With music playing there is always something else, and what it looks
 * like is a header stuttering against a list that does not (#154). Native, they
 * cannot be late whatever JS is up to.
 *
 * The search bar is the one thing that stays on this side: it animates a
 * height, which the native side does not do, so it is kept in a wrapper of its
 * own rather than added to the scroll (mixing the two in one expression is what
 * would break both).
 */
const AnimatedList = Animated.createAnimatedComponent(GHFlatList) as typeof GHFlatList;

// The reorderable list animates a dragged row, which needs the cells mounted
// inside the virtual window: `removeClippedSubviews` is what hides them, and the
// library leaves that prop out of its own type for the same reason (the queue and
// `PlaylistReorder` carry the same note).
const dragPerf = {
  initialNumToRender: listPerf.initialNumToRender,
  maxToRenderPerBatch: listPerf.maxToRenderPerBatch,
  windowSize: listPerf.windowSize,
};

/** Normalizes for searching: lowercase and without accents. */
function normQ(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

interface Props {
  title: string;
  subtitle?: string;
  /** If provided, the subtitle links to the artist when tapped. */
  artistId?: string;
  /** Album artists; with multiple, the subtitle opens the picker. */
  artists?: { id: string; name: string }[];
  /** Circular artist photo next to the subtitle (Spotify style). */
  artistImageUri?: string;
  /**
   * What the list says about itself (a playlist's or an album's description),
   * above the metadata. Two lines, with "Show more" under them when there is
   * more: the words say the tap is there, which is what a bare cut text never
   * did. Whoever wants the header quiet turns it off in Settings › Appearance.
   */
  description?: string;
  /** Metadata line (e.g. "Album · 2021 · 12 songs · 48 min"). */
  meta?: string;
  /**
   * The record carries a parental advisory: the E goes at the head of the
   * metadata line. A word in that line would have said the same thing, but the
   * badge is what the rows below it use and reading one mark in two shapes on
   * the same screen is worse than reading it twice.
   */
  explicit?: boolean;
  /** Genres of the album, as a scrollable row of chips that browse each one.
   *  Empty or absent shows nothing at all, not an empty row. */
  genres?: string[];
  coverUri?: string;
  /** Custom cover art (e.g. Favorites artwork); replaces coverUri. */
  renderCover?: (size: number) => ReactNode;
  /** If provided, the cover is tappable (e.g. open the fullscreen viewer). */
  onCoverPress?: () => void;
  /** Hides the header cover and reclaims that space (e.g. Favorites). */
  hideCover?: boolean;
  /**
   * Full-bleed cover across the top (the radio's): edge to edge from the very
   * top of the display, cropped to `height`, with the gradient starting at
   * its lower edge instead of running behind it. Clamped inside so it always
   * ends a little above where the square cover would; the rows keep their own
   * width, only the picture takes the whole screen.
   */
  wideCover?: {
    height: number;
    render: (width: number, height: number) => ReactNode;
  };
  /** Gradient/bar color if there's no cover with a dominant color. */
  accentColor?: string;
  songs: Song[];
  currentId?: string;
  /** Numbers the tracks (useful on albums). */
  numbered?: boolean;
  /**
   * Disc header to render ABOVE the row at that index (multi-disc albums):
   * index → label map ("Disc 2", disc title...). Only used without an active
   * search filter (filtered results have no discs).
   */
  discHeaders?: Record<number, string>;
  /** If provided, shows a heart to mark the album as a favorite. */
  favorite?: { id: string; type: StarType; starred: boolean; podcast?: true };
  /**
   * Podcast episodes: the ids the user has hearted in SQLite, so each row can
   * light its own heart. Passed in by the podcast screen (which already reads
   * them); absent for albums/playlists, whose rows use the server's list.
   */
  podcastFavIds?: Set<string>;
  /**
   * Podcast episodes on the show's screen: per-episode description, publish
   *  date and whether the episode arrived with the show's last sync, keyed by
   *  episode id, so each row can show them (see `TrackRow`'s `episode`). The
   *  screen builds it once from the episodes it already holds; absent for
   *  albums and playlists, whose rows keep the artist line.
   */
  episodeInfo?: Map<string, { description?: string; publishedAt?: number; fresh: boolean }>;
  /** Offline download button (album/playlist header). */
  download?: {
    status: 'none' | 'active' | 'done';
    /** Progress 0..1 while `status` is 'active'. */
    progress: number;
    onPress: () => void;
  };
  /** If provided, shows a ⋯ button. */
  onMenu?: () => void;
  /** If provided, each song's menu allows removing it from this playlist. */
  playlistId?: string;
  /** Real server index for each song, in case the list is reordered. */
  playlistIndices?: number[];
  /** If provided, shows a sort button to the left of ⋯. */
  onSort?: () => void;
  /**
   * Action row below the others (Spotify style), e.g. "+ Add…" in Favorites.
   * The icon is "+" unless another is specified (the mix screen uses it to
   * reshuffle).
   */
  addAction?: { label: string; icon?: keyof typeof Icon.glyphMap; onPress: () => void };
  /** Extra content at the bottom of the list (e.g. "More from this artist"). */
  footer?: ReactNode;
  /** What to show below the header when there are no songs (e.g. empty playlist). */
  emptyState?: ReactNode;
  /** Shows the mini album cover on each row (playlists/favorites). */
  showArtwork?: boolean;
  /**
   * Hidden "search in list" bar above the header: revealed by pulling down
   * from the very top (Spotify-style gesture).
   */
  searchable?: boolean;
  /** Search bar hint text (defaults to "Find in playlist"). */
  searchPlaceholder?: string;
  /**
   * Enables multi-select (enter via long-press on a row). Each action receives
   * the marked songs; `indices` are their real positions (via `playlistIndices`
   * if the list is reordered).
   */
  selection?: {
    /** Remove from this list (playlist: by index; favorites: unstar). */
    onRemove?: (songs: Song[], indices: number[]) => void;
    /** Add to another playlist. */
    onAddTo?: (songs: Song[]) => void;
    /** Bulk download. */
    onDownload?: (songs: Song[]) => void;
    /** Favorites screen: there, "Remove" already is unfavouriting. */
    favorites?: boolean;
    /**
     * Where the order of the list is the app's to rewrite (a playlist): a row
     * answers a hold by travelling to another place on the list, and the screen
     * is handed the whole new sequence when it decides to keep it. Only while
     * selecting — outside the selection a vertical drag is a scroll, and the
     * row's own sideways swipe is a pan that would fight the list's (#279).
     */
    reorder?: { onSave: (songIds: string[]) => void };
  };
  /** `opts` goes straight to `playQueue`: the shuffle button asks for the list
   *  dealt, which the screen owning the songs is the one who can request. */
  onPlay: (startIndex: number, opts?: { shuffled?: boolean }) => void | Promise<void | boolean>;
}

export function TrackListView({
  title,
  subtitle,
  artistId,
  artists,
  artistImageUri,
  description,
  meta,
  explicit,
  genres,
  coverUri,
  renderCover,
  onCoverPress,
  hideCover,
  wideCover,
  accentColor,
  songs,
  currentId,
  numbered,
  discHeaders,
  favorite,
  podcastFavIds,
  episodeInfo,
  download,
  onMenu,
  playlistId,
  playlistIndices,
  onSort,
  addAction,
  footer,
  emptyState,
  showArtwork,
  searchable,
  searchPlaceholder,
  selection,
  onPlay,
}: Props) {
  const router = useRouter();
  const t = useT();
  const insets = useInsets();
  const { width: screenW, height: screenH } = useScreenSize();
  // The bar's two ends: the back chevron on the left, the play button on the
  // right, and the button is the wider of the two. The title takes the larger
  // of the clearances on *both* sides, so a long name stops short of the
  // button instead of running under it, and the name itself still sits in the
  // middle of the screen rather than a button's width to the left of it.
  const titleInset = centredPadding(screenW, spacing.lg) + PLAY_SIZE + spacing.md;
  const bottomPad = useScreenBottomPadding();
  const tint = useCoverTint(coverUri, true);
  const dominant = tint.color;
  // A cover read for the first time fades its tint in over the page, instead
  // of the header being painted the plain grey and jumping to the colour a
  // moment later. One already read is there from the first frame.
  const tintIn = useRef(new Animated.Value(tint.known ? 1 : 0)).current;
  useEffect(() => {
    if (!tint.known) return;
    Animated.timing(tintIn, { toValue: 1, duration: motion.duration.fade, useNativeDriver: true }).start();
  }, [tint.known, tintIn]);
  const headerColor = accentColor ?? dominant;
  const shuffle = usePlayerStore((s) => s.shuffle);
  const queueDealt = usePlayerStore((s) => s.queueDealt);
  // The shuffle button gets tinted only if this list is the one playing;
  // otherwise, the (global) shuffle mode would also tint the buttons of
  // unrelated albums/playlists, which was confusing.
  //
  // The mode is not the only way to end up listening shuffled: this button
  // hands the list over dealt without touching the mode (see `shufflePlay`),
  // and reading the mode alone meant pressing it lit nothing at all. What it
  // says is "what you are hearing is this list, shuffled", however it got that
  // way, so tapping a song in the list afterwards puts it out again.
  const shuffleActive = useMemo(
    () => (shuffle || queueDealt) && !!currentId && songs.some((s) => s.id === currentId),
    [shuffle, queueDealt, currentId, songs],
  );
  const openArtistPicker = useArtistPicker((s) => s.open);
  // The caller worked out whether the record carries an advisory; whether it is
  // drawn is the badge's own switch, asked here so the metadata line is not
  // built around a badge that never comes.
  const showExplicit = useExplicitBadge(explicit ? 'explicit' : undefined);
  const subtitleTargets = artistTargets({ artistId, artists });
  const onSubtitlePress =
    subtitleTargets.length > 1
      ? () => openArtistPicker(subtitleTargets)
      : subtitleTargets.length === 1
        ? () => router.push(`/artist/${subtitleTargets[0].id}`)
        : undefined;

  const scrollY = useRef(new Animated.Value(0)).current;

  // ── In-list search ──────────────────────────────────────────────────────
  // The bar is rendered collapsed (height 0) above the header; a pull-down
  // gesture when the list is at the very top reveals it, and scrolling back
  // collapses it. Like Spotify's "Find in playlist".
  const listRef = useRef<GHFlatList<Song>>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [descriptionHasMore, setDescriptionHasMore] = useState(false);
  /** Last real scroll offset (the gesture only reveals at the top). */
  const lastOffsetY = useRef(0);
  const searchH = useRef(new Animated.Value(0)).current;
  const searchBar = !!searchable && songs.length > 0;

  // ── The play button ──────────────────────────────────────────────────────
  // The button is drawn outside the list, over the bar: it follows the place
  // it has in the header and, on reaching the bar, holds there - half in the
  // bar, half below it - so it never passes behind the bar and never fades
  // out from under the eye. What the header keeps is the place itself, laid
  // out (and measured) where the button would be.
  const headerRootRef = useRef<View>(null);
  const playBtnRef = useRef<View>(null);
  /** The button's own place in the scroll content (see the effect below). */
  const [playContentY, setPlayContentY] = useState(0);
  /** Whether the bar has reached it: from there the copy drawn over the bar
   *  takes the taps (the place itself is behind the bar by then) and is the
   *  one the screen reader is offered; before that it is the other way round,
   *  so the drags that start on the button still belong to the list. */
  const [overBar, setOverBar] = useState(false);
  const overBarRef = useRef(false);
  /** The scroll it happens at; `Infinity` until the place is known. */
  const behindAtRef = useRef(Infinity);
  /** Bumped when something moved the button without a render being able to
   *  see it (the search bar's height animation) or before it was laid out,
   *  so the measurement below runs again. Only the write is used: the
   *  effect reads no dependencies, any render will do, and this is what
   *  makes one happen. */
  const [, setMeasureTick] = useState(0);
  const measureRetries = useRef(0);

  // `setRevealed` is async: the gesture fires `onChange` many times per drag,
  // and several would pass the `!revealed` guard before the re-render, each
  // triggering haptic. The ref updates instantly and stops the rest.
  const revealedRef = useRef(false);

  function revealSearchBar() {
    if (revealedRef.current) return;
    revealedRef.current = true;
    haptic('light');
    setRevealed(true);
    Animated.timing(searchH, {
      toValue: SEARCH_H,
      duration: motion.duration.fade,
      useNativeDriver: false,
      // The header (and the play button in it) moves down as this runs, and
      // nothing re-renders when it lands: the measure below is told here.
    }).start(() => setMeasureTick((v) => v + 1));
  }

  function collapseSearchBar() {
    revealedRef.current = false;
    setRevealed(false);
    Animated.timing(searchH, {
      toValue: 0,
      duration: motion.duration.fade,
      useNativeDriver: false,
    }).start(() => setMeasureTick((v) => v + 1));
  }

  // Simultaneous pan with the list scroll: doesn't steal the gesture, just
  // observes. Android doesn't fire overscroll events (the list clamps offset
  // at 0), so the "pull down at the top" must be detected separately. The
  // simultaneity is declared on the list (simultaneousHandlers prop with the
  // gesture ref): without it, native scroll cancels this Pan before it starts.
  const revealPanRef = useRef<GestureType | undefined>(undefined);
  const revealPan = Gesture.Pan()
    .withRef(revealPanRef)
    .runOnJS(true)
    // Only downward drags: upward ones (normal scroll) cancel it.
    .activeOffsetY(10)
    .failOffsetY(-10)
    .onChange((e) => {
      if (!searchBar || searching || revealed) return;
      if (lastOffsetY.current <= 1 && e.translationY > 60) revealSearchBar();
    });

  // ── Multi-select ────────────────────────────────────────────────────────
  /**
   * One key per row: the song's id, and which time it appears if the same song
   * is in the list more than once. A playlist may hold the same track twice,
   * and while these were the plain id every one of those rows was the same row
   * as far as anything here could tell: ticking one ticked them all, and
   * removing one removed them all, which left none (#132). The queue screen
   * already numbers its rows this way, and for the same reason.
   *
   * Keyed rather than indexed because it survives what indices do not: sorting
   * the list moves every position, and `id#0` is still the same song
   * afterwards. Two rows of the same song do swap places with each other, and
   * there is nothing to tell them apart by anyway.
   */
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return songs.map((s) => {
      const n = seen.get(s.id) ?? 0;
      seen.set(s.id, n + 1);
      return `${s.id}#${n}`;
    });
  }, [songs]);

  // null = normal mode; a Set (even empty) = selecting.
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const selecting = selectedIds !== null;
  // Row that just entered selection via long-press. On release, the `onPress` of
  // that same gesture arrives with `selecting` already active and would undo the
  // selection; we discard it once. Reset in `onPressIn` (start of each press),
  // so no residue remains even if `onPress` doesn't fire after the long-press.
  const justLongPressed = useRef<string | null>(null);
  const allSelected = selecting && selectedIds.size === songs.length && songs.length > 0;

  /**
   * The row entered selection with. The drag surface below is a list of its own
   * component, so it mounts at the top of its content; the row the finger was
   * holding is what the eye is looking for, and `initialScrollIndex` keeps the
   * pair on screen instead of sending the whole list back above the bar.
   */
  const enteredAt = useRef(0);
  /**
   * The drag surface's own scroll view, for the one thing `initialScrollIndex`
   * has to do about a row it has never rendered: reach a place further down
   * than the measured cells. The virtualized list cannot know where it is
   * without a layout, and there is no layout to give here — a row's height
   * follows the reader's font and the notes under a podcast title — so the
   * failure the list reports is answered the way it asks: with the average
   * height of the rows it *has* seen, times the place to reach.
   */
  const dragListRef = useRef<FlatList<{ song: Song; index: number }>>(null);
  /**
   * What the drag surface is showing once a row has moved: each row carries its
   * place in the screen's own list, so remove and add still find the song's
   * real position after the row travelled. Keyed by that place rather than by
   * the position on the list, for the same reason `rowKeys` is keyed.
   */
  const [draggedRows, setDraggedRows] = useState<{ song: Song; index: number }[] | null>(null);
  /** Whether a drag moved a row at all: what arms the bar's save button. */
  const [dragChanged, setDragChanged] = useState(false);

  /**
   * Leaving selection mode. An order the hand made by dragging only ever exists
   * once it is saved — saving is the one thing that writes it to the server —
   * so leaving without saving is the same as never having moved the row.
   */
  function exitSelection() {
    setSelectedIds(null);
    setDraggedRows((cur) => (cur === null ? cur : null));
    setDragChanged((cur) => (cur ? false : cur));
  }

  function toggleSelect(key: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Runs a selection-mode action with the marked items and exits the mode. */
  function runSelectionAction(fn: (sel: Song[], indices: number[]) => void) {
    const sel: Song[] = [];
    const indices: number[] = [];
    songs.forEach((s, i) => {
      if (selectedIds?.has(rowKeys[i])) {
        sel.push(s);
        indices.push(playlistIndices ? playlistIndices[i] : i);
      }
    });
    exitSelection();
    if (sel.length > 0) fn(sel, indices);
  }

  const selectionMenu = useSelectionMenu(runSelectionAction, {
    favorites: selection?.favorites,
  });
  // What this list lets you do with a selection, each one built once: the bar
  // takes two of them and ⋯ holds whatever is left.
  const addToAction: SelectionAction[] = selection?.onAddTo
    ? [
        {
          icon: 'add-circle-outline',
          label: t('Add to a playlist'),
          onPress: () => runSelectionAction((sel) => selection.onAddTo!(sel)),
        },
      ]
    : [];
  const removeAction: SelectionAction[] = selection?.onRemove
    ? [
        {
          icon: 'remove-circle-outline',
          label: t('Remove'),
          onPress: () => runSelectionAction((sel, idx) => selection.onRemove!(sel, idx)),
        },
      ]
    : [];
  const downloadAction: SelectionAction[] = selection?.onDownload
    ? [
        {
          icon: 'download-outline',
          label: t('Download'),
          onPress: () => runSelectionAction((sel) => selection.onDownload!(sel)),
        },
      ]
    : [];

  // Without cover, the header is shorter: the gradient and bar collapse adjust
  // to a smaller distance so the transition fits.
  const art = coverSize(screenW, screenH);
  const artRadius = useCoverRadius(art);
  // Where the square cover's content starts: the bar's own slice of the
  // screen plus the gap under it. The wide cover starts at zero instead -
  // it goes under the bar - but is clamped so it ends just above where this
  // one would, on every screen there is.
  const albumPadTop = insets.top + TOPBAR_H + spacing.md;
  const wideH = wideCover ? Math.min(wideCover.height, albumPadTop + art - 24) : 0;
  const cover = wideCover || hideCover ? 0 : art;
  const collapse = wideCover ? wideH : hideCover ? 120 : art;
  // Down past the title and the buttons, so the header is the cover's colour
  // and not only the space around the cover. The wide one runs from its own
  // picture's edge instead: the picture is what covers the space above.
  const gradientH = wideCover ? WIDE_GRADIENT_H : insets.top + TOPBAR_H + cover + 280;
  const band = searchable && !wideCover ? SEARCH_H * 4 : 0;
  const gradientTop = wideCover ? wideH : -band;
  const coverOpacity = scrollY.interpolate({
    inputRange: [0, collapse * 0.7],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const barContentOpacity = scrollY.interpolate({
    inputRange: [collapse * 0.5, collapse * 0.85],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const barBgOpacity = scrollY.interpolate({
    inputRange: [0, collapse * 0.85],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  // Where the play button sits in the scroll content: its distance from the
  // top of the list header, plus the padding the list starts with - which is
  // the same expression the list is padded by below, so the two cannot drift
  // apart. The wide cover needs no top padding: its picture is the top.
  const listPadTop = wideCover ? 0 : albumPadTop;

  // The two ends of that distance are read in window coordinates in the same
  // tick, so the scroll underneath them cancels out: the number is the same
  // whether the list is at rest or mid-fling. Adding the scroll offset by
  // hand instead would not be - the offset JS has is a frame behind whatever
  // is on screen, and a fling travels a long way in a frame.
  //
  // Measured after every render (the header moves for reasons a render knows
  // about: the description opening, the search bar's height landing) and
  // again when the search bar's animation ends, which no render sees.
  useLayoutEffect(() => {
    if (searching) return;
    const btn = playBtnRef.current;
    const head = headerRootRef.current;
    if (!btn || !head) return;
    let btnY: number | null = null;
    let headY: number | null = null;
    const both = () => {
      if (btnY === null || headY === null) return;
      const rel = btnY - headY;
      if (rel <= 0) {
        // Nothing laid out yet: the first frame, before the header has a
        // place to report. A few tries at most, then give up - a button that
        // never turns up is one that is not on screen.
        if (measureRetries.current < 5) {
          measureRetries.current += 1;
          requestAnimationFrame(() => setMeasureTick((v) => v + 1));
        }
        return;
      }
      measureRetries.current = 0;
      const y = listPadTop + rel;
      setPlayContentY((cur) => (Math.abs(cur - y) > 2 ? y : cur));
    };
    btn.measureInWindow((_bx, by) => {
      if (typeof by === 'number') {
        btnY = by;
        both();
      }
    });
    head.measureInWindow((_hx, hy) => {
      if (typeof hy === 'number') {
        headY = hy;
        both();
      }
    });
  });

  // The line the button holds on: centred on the bar's lower edge, so half of
  // it is in the bar and half of it is under it. Below it the button tracks
  // the header 1:1 (the interpolation's slope is the scroll's own), from there
  // on it does not move at all.
  const dockTop = insets.top + TOPBAR_H - PLAY_SIZE / 2;
  // The revealed search row is not scroll: it sits above the header and pushes
  // it down without the offset moving, so the button starts that much lower and
  // reaches the line that much later. Its height is animated from JS (a height
  // is not something the scroll's native driver does), which is why it travels
  // in a wrapper of its own below rather than in the interpolation.
  const searchShift = revealed ? SEARCH_H : 0;
  // The scroll at which the button's top reaches the bar's lower edge: from
  // there the bar is between it and the eye (and between it and the hand).
  const behindAt = Math.max(playContentY + searchShift - (insets.top + TOPBAR_H), 1);
  const dockAt = Math.max(playContentY + searchShift - dockTop, 1);
  const playDockY = scrollY.interpolate({
    inputRange: [0, dockAt],
    outputRange: [playContentY, dockTop - searchShift],
    // Left extends, right clamps: once docked the button goes no further, but
    // while the list is rubber-banded past the top the header keeps moving down
    // and the button has to move with it instead of sitting still (#overscroll).
    extrapolateLeft: 'extend',
    extrapolateRight: 'clamp',
  });

  // Which of the two circles shows. Until the bar reaches it, the one laid out
  // in the header: it is part of the list, so Android's overscroll stretch
  // (which moves no offset, so nothing driven by the offset can follow it)
  // takes it along with the buttons beside it. From there the copy over the
  // bar, sitting on exactly the same spot at the switch. Both on the native
  // driver, so the swap lands on one frame.
  const slotOpacity = scrollY.interpolate({
    inputRange: [behindAt - 1, behindAt],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const dockOpacity = scrollY.interpolate({
    inputRange: [behindAt - 1, behindAt],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  // The threshold the listener reads, kept with what it depends on.
  useLayoutEffect(() => {
    behindAtRef.current = playContentY > 0 ? behindAt : Infinity;
    const should = playContentY > 0 && lastOffsetY.current >= behindAt;
    if (should !== overBarRef.current) {
      overBarRef.current = should;
      setOverBar(should);
    }
  }, [behindAt, playContentY]);

  // Live filtering; preserves each song's original index so play/enqueue/remove
  // still point to the correct position.
  const filtered = useMemo(() => {
    const q = normQ(query.trim());
    if (!searchable || !q) return null;
    const rows: { song: Song; index: number }[] = [];
    songs.forEach((song, index) => {
      if (normQ(song.title).includes(q) || (song.artist && normQ(song.artist).includes(q)))
        rows.push({ song, index });
    });
    return rows;
  }, [searchable, query, songs]);
  const shownSongs = useMemo(
    () => (filtered ? filtered.map((r) => r.song) : songs),
    [filtered, songs],
  );

  function cancelSearch() {
    Keyboard.dismiss();
    setQuery('');
    setSearching(false);
    collapseSearchBar();
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }

  function shufflePlay() {
    if (songs.length === 0) return;
    // The queue itself comes out dealt; the shuffle mode is not touched. It
    // used to be turned on here, and since the mode is remembered between
    // sessions it stayed on for the next album someone pressed Play on.
    void onPlay(0, { shuffled: true });
  }

  /**
   * Where a hold on a row moves it: only while selecting, and only where the
   * screen said the order is its own to rewrite. Outside the selection a
   * vertical drag is the list's scroll, and the row's own sideways swipe is a
   * pan that would fight the list's; while searching, the rows shown are not
   * the whole list, and moving part of a list through another part is not a
   * thing that has a meaning.
   */
  const dragging = selecting && !!selection?.reorder && !searching;
  /** The rows the drag surface starts from: the display order, each carrying
   * its place in the screen's list. */
  const dragRows = useMemo(
    () => songs.map((song, index) => ({ song, index })),
    [songs],
  );

  /**
   * One row of the list, for both list engines: the reorderable one hands a row
   * to another place on the list, so the row is told where it sits in the
   * screen's own list and not only where it sits on the screen — everything the
   * rows answer with (the play button, the ⋯ menu, removing) still points at
   * the same song after the row travelled.
   */
  function renderRow(
    song: Song,
    index: number,
    draggable: boolean,
    /** A disc header to render above this row (multi-disc albums). */
    discLabel?: string,
  ) {
    const rowKey = rowKeys[index];
    // This episode's description and date, when the screen passed them
    // (only the show's own does); the row's identity is stable, so the
    // row's memo holds across repaints.
    const ep = episodeInfo?.get(song.id);
    const rowProps = {
      song,
      episode: ep,
      // With artwork visible the number is omitted: the album stays as
      // usual (only the artist's Popular shows number + cover).
      position: numbered && !showArtwork ? song.track ?? index + 1 : undefined,
      isCurrent: currentId === song.id,
      showArtwork,
      podcastFavIds,
      menuContext:
        playlistId
          ? { playlistId, index: playlistIndices ? playlistIndices[index] : index }
          : undefined,
      selecting,
      selected: !!selectedIds?.has(rowKey),
      onPressIn: () => {
        justLongPressed.current = null;
      },
      onPress: () => {
        // Discards the onPress that follows the selection long-press:
        // otherwise it would deselect the song you entered selection with.
        if (justLongPressed.current === rowKey) return;
        if (selecting) toggleSelect(rowKey);
        else onPlay(index);
      },
    };
    // A row of the drag surface carries no swipe wrapper: while selecting the
    // swipe is off anyway, and a row answering a pan of its own below a list
    // that pans is two panes fighting for the same finger.
    const row = draggable
      ? <DragTrackRow {...rowProps} swipeable={false} />
      : (
        <TrackRow
          {...rowProps}
          onLongPress={
            selection && !selecting
              ? () => {
                  haptic('medium');
                  setSelectedIds(new Set([rowKey]));
                  justLongPressed.current = rowKey;
                  enteredAt.current = index;
                }
              : undefined
          }
        />
      );
    if (!discLabel) return row;
    return (
      <>
        <DiscHeader label={discLabel} />
        {row}
      </>
    );
  }

  /** The whole list's footer, whichever list is on screen. */
  const listFooter = footer ? <>{footer}</> : null;

  /**
   * Keeping what the hand arranged: the button the drag arms. It leaves
   * selection mode like every other action, and hands the screen the whole
   * sequence, which is what writes it — an order is the list's, so the marks
   * play no part in it.
   */
  const saveOrderAction: SelectionAction[] = selection?.reorder
    ? [
        {
          icon: 'swap-vertical',
          label: t('Save order'),
          onPress: () => {
            const rows = draggedRows ?? dragRows;
            const ids = rows.map((r) => r.song.id);
            exitSelection();
            selection.reorder!.onSave(ids);
          },
        },
      ]
    : [];

  // The play button over the bar. It follows the place laid out for it in the
  // header - the search row's height riding in the outer wrapper, the scroll
  // in the one inside it - until it reaches the bar's line, and holds there:
  // half in the bar, half below its lower edge. Drawn after the bar (below),
  // so it is in front of it. Until the bar reaches it, it is the header's own
  // circle that shows (see `slotOpacity`), and the taps and the screen reader
  // are the header's too.
  const playOverlay =
    searching || playContentY <= 0 ? null : (
      <Animated.View
        pointerEvents={overBar && !selecting ? 'auto' : 'none'}
        accessibilityElementsHidden={!overBar || selecting}
        importantForAccessibility={overBar && !selecting ? 'auto' : 'no-hide-descendants'}
        style={[styles.playDock, { right: centredPadding(screenW, spacing.lg) }]}
      >
        <Animated.View style={{ transform: [{ translateY: searchH }] }}>
          <Animated.View style={{ opacity: dockOpacity, transform: [{ translateY: playDockY }] }}>
            <Pressable
              style={[styles.playButton, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={t('Play')}
              onPress={() => songs.length > 0 && onPlay(0)}
            >
              <Icon name="play" size={28} color={colors.onAccent} />
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    );

  /**
   * The header above the rows, taken out of the list so both list engines
   *  mount it: it is the same furniture above the rows whichever way the
   *  rows can be answered, and a drag surface without it would be a cover
   *  and a title vanishing under the finger the moment the selection came
   *  in.
   */
  const listHeader = (
    <View>
      {searchBar ? (
        /* Collapsed = height 0 (invisible); the gesture reveals it. The clip
           goes in a no-padding container: any padding would impose a
           minimum height and show a sliver. */
        <Animated.View style={[styles.searchClip, { height: searchH }]}>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Icon name="search" size={18} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder={searchPlaceholder ?? t('Find in playlist')}
              placeholderTextColor={colors.textSecondary}
              value={query}
              onChangeText={setQuery}
              onFocus={() => setSearching(true)}
              returnKeyType="search"
              autoCorrect={false}
            />
            {query.length > 0 ? (
              <Pressable
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('Clear')}
                onPress={() => setQuery('')}
              >
                <Icon name="close-circle" size={18} color={colors.textSecondary} />
              </Pressable>
            ) : null}
          </View>
          {searching ? (
            <Pressable hitSlop={8} accessibilityRole="button" onPress={cancelSearch}>
              <Text style={styles.searchCancel}>{t('Cancel')}</Text>
            </Pressable>
          ) : null}
        </View>
        </Animated.View>
      ) : null}
      {/* While searching, the large header is hidden: results stay flush
          with the bar, which is what Spotify does. It is also what the
          button's place is measured against, and not the wrapper: the
          search row above it is not scroll, and its height travels with
          the button on its own (see `searchShift`). */}
      {searching ? null : (
    <View ref={headerRootRef} style={styles.header}>
      {wideCover ? (
        /* Paint above the first pixel: the pull-down bounce reveals
           whatever sits above the content - the page background by
           default - and on the radio that strip must stay the accent,
           the cover's own colour. Zero net layout: it hangs off the top
           of the header, off screen until a pull uncovers it. */
        <View
          pointerEvents="none"
          style={{
            width: screenW,
            height: OVERSCROLL_H,
            marginTop: -OVERSCROLL_H,
            marginHorizontal: -centredPadding(screenW, spacing.lg),
            backgroundColor: headerColor,
          }}
        />
      ) : null}
      {wideCover ? (
        /* The picture at the very top, pulled out of the rows' inset to
           the edges of the display: it fades with the scroll the way
           the square one does, and the bar rides over it. */
        <Animated.View
          style={[
            styles.wideCover,
            {
              width: screenW,
              height: wideH,
              opacity: coverOpacity,
              marginHorizontal: -centredPadding(screenW, spacing.lg),
            },
          ]}
        >
          {onCoverPress ? (
            <Pressable
              onPress={onCoverPress}
              accessibilityRole="imagebutton"
              accessibilityLabel={t('View cover')}
            >
              {wideCover.render(screenW, wideH)}
            </Pressable>
          ) : (
            wideCover.render(screenW, wideH)
          )}
        </Animated.View>
      ) : hideCover ? null : (
        <Animated.View style={[styles.coverCenter, { opacity: coverOpacity }]}>
          {/* Android draws no shadow from a transparent view's content
              the way iOS does: there it is a box shadow the size and
              shape of the cover. */}
          <View
            style={
              Platform.OS === 'android'
                ? { borderRadius: artRadius, boxShadow: '0px 10px 32px rgba(0, 0, 0, 0.45)' }
                : null
            }
          >
            {onCoverPress ? (
              <Pressable
                onPress={onCoverPress}
                accessibilityRole="imagebutton"
                accessibilityLabel={t('View cover')}
              >
                {renderCover ? renderCover(art) : <Cover uri={coverUri} size={art} />}
              </Pressable>
            ) : renderCover ? (
              renderCover(art)
            ) : (
              <Cover uri={coverUri} size={art} />
            )}
          </View>
        </Animated.View>
      )}
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? (
        onSubtitlePress ? (
          <Pressable hitSlop={6} style={styles.subtitleRow} onPress={onSubtitlePress}>
            {artistImageUri ? (
              <View style={styles.artistPhoto}>
                <Cover uri={artistImageUri} size={24} />
              </View>
            ) : null}
            <Text style={[styles.subtitle, styles.subtitleLink]}>{subtitle}</Text>
          </Pressable>
        ) : (
          <Text style={styles.subtitle}>{subtitle}</Text>
        )
      ) : null}
      {description?.trim() ? (
        <View>
          {/* The whole text, drawn invisibly: with `numberOfLines` set,
              onTextLayout only reports the lines that survived, so the
              copy below can't tell whether anything was cut. */}
          <Text
            style={styles.descriptionMeasure}
            onTextLayout={(e) =>
              setDescriptionHasMore(e.nativeEvent.lines.length > DESCRIPTION_LINES)
            }
          >
            {description.trim()}
          </Text>
          <Text
            style={styles.description}
            numberOfLines={descriptionExpanded ? undefined : DESCRIPTION_LINES}
          >
            {description.trim()}
          </Text>
          {descriptionHasMore ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setDescriptionExpanded((v) => !v)}
              style={styles.descriptionMore}
              hitSlop={spacing.sm}
            >
              <Text style={styles.descriptionMoreText}>
                {descriptionExpanded ? t('Show less') : t('Show more')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {showExplicit || meta ? (
        <View style={styles.metaRow}>
          {showExplicit ? <ExplicitBadge status="explicit" /> : null}
          {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        </View>
      ) : null}
      {/* Deliberately quiet: same weight as the metadata line above, so
          it reads as one more piece of album info and not as a control.
          Horizontal because an album with eight tags shouldn't push the
          play button down the screen. */}
      {genres && genres.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.genres}
          contentContainerStyle={styles.genresContent}
        >
          {genres.map((g) => (
            <Link key={g} href={`/genre/${encodeURIComponent(g)}`} asChild>
              <Pressable style={styles.genreChip}>
                <Text style={styles.genreText}>{g}</Text>
              </Pressable>
            </Link>
          ))}
        </ScrollView>
      ) : null}
  
      <View style={styles.actions}>
        <View style={styles.actionsLeft}>
          {favorite ? (
            <FavoriteButton
              id={favorite.id}
              type={favorite.type}
              starred={favorite.starred}
              podcast={favorite.podcast ? { kind: 'channel', channelId: favorite.id } : undefined}
              size={28}
            />
          ) : null}
          {download ? (
            <Pressable
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={
                download.status === 'done' ? t('Remove download') : t('Download')
              }
              onPress={download.onPress}
              style={styles.downloadWrap}
            >
              {download.status === 'active' ? (
                <>
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={[styles.downloadProgress, { color: colors.accent }]}>
                    {Math.round(download.progress * 100)}%
                  </Text>
                </>
              ) : (
                <Icon
                  name={
                    download.status === 'done'
                      ? 'arrow-down-circle'
                      : 'arrow-down-circle-outline'
                  }
                  size={26}
                  color={download.status === 'done' ? colors.accent : colors.textSecondary}
                />
              )}
            </Pressable>
          ) : null}
          {onSort ? (
            <Pressable
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('Sort')}
              onPress={onSort}
            >
              <Icon name="swap-vertical" size={24} color={colors.textSecondary} />
            </Pressable>
          ) : null}
          {onMenu ? (
            <Pressable
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('More options')}
              onPress={onMenu}
            >
              <Icon name="ellipsis-horizontal" size={26} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
  
        <View style={styles.actionsRight}>
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('Shuffle')}
            onPress={shufflePlay}
          >
            <Icon
              name="shuffle"
              size={26}
              color={shuffleActive ? colors.accent : colors.textSecondary}
            />
          </Pressable>
          {/* The button while it is still in the header: drawn here so
              it moves with the list, overscroll included, and taking the
              taps from there down - a dragger that starts on it is the
              list's, as it always was. */}
          <Pressable
            ref={playBtnRef}
            style={styles.playSlot}
            collapsable={false}
            accessibilityElementsHidden={overBar && !selecting}
            importantForAccessibility={
              overBar && !selecting ? 'no-hide-descendants' : 'auto'
            }
            accessibilityRole="button"
            accessibilityLabel={t('Play')}
            onPress={() => songs.length > 0 && onPlay(0)}
          >
            <Animated.View
              style={[
                styles.playButton,
                { backgroundColor: colors.accent, opacity: slotOpacity },
              ]}
            >
              <Icon name="play" size={28} color={colors.onAccent} />
            </Animated.View>
          </Pressable>
        </View>
      </View>
  
      {addAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={addAction.onPress}
          style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.6 }]}
        >
          <View style={styles.addBox}>
            <Icon
              name={addAction.icon ?? 'add'}
              size={26}
              color={colors.textSecondary}
            />
          </View>
          <Text style={styles.addLabel}>{addAction.label}</Text>
        </Pressable>
      ) : null}
    </View>
      )}
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={{ flex: 1 }}>
      {/* Dominant color gradient; scrolls with 1:1 parallax. Hidden in search
          mode to keep the screen flat black. It also goes while the rows can
          be dragged: the drag list owns its scroll, so a gradient driven by
          this side's offset would stay put under rows that move over it. */}
      {searching || dragging ? null : (
        <Animated.View
          pointerEvents="none"
            style={[
              styles.gradientWrap,
              {
                top: gradientTop,
                height: gradientH + band,
              // Moves down with the revealed search bar, which pushes the header
              // down without moving the scroll offset. On its own view, because
              // this is a height animated from JS and the scroll below is not:
              // one expression holding both would drag the scroll back onto this
              // side, which is the whole thing being avoided (see `AnimatedList`).
              transform: [{ translateY: searchH }],
            },
          ]}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              // And follows the scroll 1:1, natively - but never below zero:
              // an over-scroll drags `scrollY` negative, and the gradient
              // moving down with it would uncover the page's own colour where
              // the accent's band sits. Held at the top, the bounce reveals
              // the accent instead of the background. The tint itself fades
              // in with `tintIn`, rather than flashing grey first.
              {
                opacity: tintIn,
                transform: [
                  {
                    translateY: scrollY.interpolate({
                      inputRange: [-1e7, 0, 1e7],
                      outputRange: [0, 0, -1e7],
                      extrapolate: 'clamp',
                    }),
                  },
                ],
              },
            ]}
          >
            {/* Color band above the gradient: when the search bar is revealed,
                content shifts down SEARCH_H px and this fills the gap at the top.
                Inside the view's own bounds: hanging above them, Android left
                the gap grey. */}
            {band > 0 ? (
              <View style={[styles.gradientAbove, { height: band, backgroundColor: headerColor }]} />
            ) : null}
            <LinearGradient
              {...easedFade(headerColor, colors.background)}
              style={[StyleSheet.absoluteFill, { top: band }]}
            />
          </Animated.View>
        </Animated.View>
      )}

      {/* Where the rows can be dragged: a different list — the library's
          reorderable one — under the same header, because what the hand works
          on are the rows and the rows keep their place in the screen's list.
          Its rows answer a hold by going to the list's own pan, and the bar
          carries the button that keeps the new order. The press that entered
          the selection is not one of the drags: this list only mounts once the
          selection is in, so a row goes where the next hold and move take it.
          The pull-down that reveals the search bar is not offered here: the pan
          this list answers is a drag, not a scroll, and the gradient above stays
          where it is, so it goes away instead of sitting still under rows that
          move. */}
      {dragging ? (
        <ReorderableList
          {...dragPerf}
          ref={dragListRef}
          // A list of its own mounts when the selection comes in; the row the
          // finger was holding is what the eye is looking for, so the drag
          // surface opens around it instead of at the top of the playlist.
          // The place it opens at is not one the list can see: the row is
          // usually far enough down that nothing has been rendered or measured
          // out there, and a layout to hand over is not a thing this list has
          // (a row's height follows the reader's font, and a podcast's notes
          // run under its title), so the failure the list answers for is
          // handled below, at `onScrollToIndexFailed`.
          initialScrollIndex={Math.max(0, enteredAt.current - 1)}
          data={draggedRows ?? dragRows}
          keyExtractor={(row, index) => rowKeys[row.index]}
          // Where `initialScrollIndex` asked to stop, the list could not see:
          // its own report carries the average height of the rows it did
          // render, and that times the place is as close as anything can get
          // without a layout — and a hand that has just come down on a row is
          // about to move it anyway, so the row under the finger is the one
          // that travels. One attempt per list, never on a scroll.
          onScrollToIndexFailed={({ averageItemLength, index }) =>
            void dragListRef.current?.scrollToOffset({
              offset: averageItemLength * index,
              animated: false,
            })
          }
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.list,
            {
              paddingTop: listPadTop,
              paddingBottom: bottomPad,
              // Centred on a wide screen instead of stretched across it: a row
              // whose title is at one edge and whose duration is at the other,
              // a hand's width apart, is a phone screen that was pulled (#131).
              paddingHorizontal: centredPadding(screenW, spacing.lg),
            },
          ]}
          extraData={selectedIds}
          renderItem={({ item }) => renderRow(item.song, item.index, true)}
          ListEmptyComponent={emptyState ? <>{emptyState}</> : null}
          ListFooterComponent={listFooter}
          ListHeaderComponent={listHeader}
          onReorder={({ from, to }: ReorderableListReorderEvent) => {
            // Released where it came down: nothing moved, nothing to save.
            if (from === to) return;
            setDragChanged((cur) => (cur ? cur : true));
            setDraggedRows((cur) => {
              const next = (cur ?? dragRows).slice();
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            });
          }}
        />
      ) : (
        <GestureDetector gesture={revealPan}>
        <AnimatedList
          ref={listRef}
          simultaneousHandlers={revealPanRef}
          {...listPerf}
          // Each row mounts a ReanimatedSwipeable (gestures + reanimated); with
          // `removeClippedSubviews` (known Android bug) those heavy rows render
          // blank and take a while to appear when scrolling large lists.
          // Disabling it here keeps them mounted within the virtual window.
          removeClippedSubviews={false}
          data={shownSongs}
          // The row's own key, not the song's: the same song can be in the list
          // twice and React was being handed the same key for both.
          keyExtractor={(_, index) => rowKeys[filtered ? filtered[index].index : index]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[
            styles.list,
            {
              paddingTop: listPadTop,
              paddingBottom: bottomPad,
              // Centred on a wide screen instead of stretched across it: a row
              // whose title is at one edge and whose duration is at the other,
              // a hand's width apart, is a phone screen that was pulled (#131).
              paddingHorizontal: centredPadding(screenW, spacing.lg),
            },
          ]}
          scrollEventThrottle={16}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
            // The listener still runs on this side: a native event is delivered to
            // JS as well, it just no longer has to be for the animation to move.
            useNativeDriver: true,
            listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
              const y = e.nativeEvent.contentOffset.y;
              lastOffsetY.current = y;
              // Scrolling down with the bar open collapses it.
              if (revealed && !searching && y > 30) collapseSearchBar();
              // The bar reaching the button hands the taps (and the screen
              // reader) over to what is drawn above the bar.
              const should = y >= behindAtRef.current;
              if (should !== overBarRef.current) {
                overBarRef.current = should;
                setOverBar(should);
              }
            },
          })}
          ListHeaderComponent={listHeader}
          extraData={selectedIds}
          renderItem={({ item, index }) => {
            // With an active filter, `index` is the position in results; everything
            // else (play, remove, numbering) uses the original position.
            const origIndex = filtered ? filtered[index].index : index;
            // Disc header (only when not searching, where origIndex === index).
            return renderRow(
              item,
              origIndex,
              false,
              filtered ? undefined : discHeaders?.[origIndex],
            );
          }}
          ListEmptyComponent={
            filtered ? (
              <Text style={styles.noResults}>{t('No results for “{q}”', { q: query.trim() })}</Text>
            ) : emptyState ? (
              <>{emptyState}</>
            ) : null
          }
          ListFooterComponent={listFooter}
        />
        </GestureDetector>
      )}
      </View>

      {/* In selection mode the button is drawn under the bar: that bar belongs
          to the selection, and the button would land on its own controls -
          which is where the header's button always was, behind it. */}
      {selecting ? playOverlay : null}

      {/* Fixed top bar: the background and title appear on collapse. In
          selection mode it's replaced by ✕ + counter + select all. */}
      <View style={[styles.bar, { height: insets.top + TOPBAR_H, paddingTop: insets.top }]}>
        {selecting ? (
          <>
            {/* The same bar, the same colour falling away: the two swap in
                place, and a flat one behind the counter would read as the
                bar changing rather than as what it says changing. */}
            <TopBarBackground color={headerColor} opacity={1} />
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('Close')}
              onPress={exitSelection}
            >
              <Icon name="close" size={26} color={colors.text} />
            </Pressable>
            <Text style={styles.barTitle} numberOfLines={1}>
              {t('{n} selected', { n: selectedIds.size })}
            </Text>
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('Select all')}
              onPress={() =>
                setSelectedIds(allSelected ? new Set() : new Set(rowKeys))
              }
            >
              <Icon
                name="checkmark-done"
                size={24}
                color={allSelected ? colors.accent : colors.text}
              />
            </Pressable>
          </>
        ) : (
          <>
            <TopBarBackground color={headerColor} opacity={barBgOpacity} />
            <BackChevron size={28} label={t('Close')} />
            <Animated.Text
              style={[
                styles.barTitleCentered,
                {
                  top: insets.top + 10,
                  opacity: barContentOpacity,
                  left: titleInset,
                  right: titleInset,
                },
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {title}
            </Animated.Text>
          </>
        )}
      </View>

      {/* Over the bar everywhere else: it is the only copy of the button
          there is, so it has to be in front of it at all times. */}
      {selecting ? null : playOverlay}

      {selecting ? (
        <SelectionBar
          count={selectedIds.size}
          // Second slot: taking songs out of this list where that is a thing,
          // and downloading where it isn't. Whichever one loses the slot is
          // the one behind ⋯.
          actions={[...addToAction, ...(removeAction.length > 0 ? removeAction : downloadAction)]}
          menu={[
            ...(removeAction.length > 0 ? downloadAction : []),
            ...selectionMenu.actions,
          ]}
          // The drag's commit button: an order belongs to the list, so it sits
          // beside the marked songs' actions and not behind ⋯, and it stays
          // dimmed until a row actually went somewhere.
          reorder={
            dragging ? { action: saveOrderAction[0], ready: dragChanged } : undefined
          }
        />
      ) : null}
      {selectionMenu.dialogs}
    </View>
  );
}

/** Disc header (thin separator + label) for multi-disc albums. */
function DiscHeader({ label }: { label: string }) {
  return (
    <View style={styles.discHeader}>
      <Text style={styles.discHeaderText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = themed((colors) => ({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  gradientWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  gradientAbove: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  searchClip: {
    overflow: 'hidden',
  },
  searchRow: {
    height: SEARCH_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // The gap to the cover goes inside the animated height: this way it
    // collapses along with the bar (an external margin would always be visible).
    paddingBottom: spacing.md,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // Translucent to let the header's dominant color through (Spotify).
    backgroundColor: colors.highlight,
    // A capsule with Round, a rounded rectangle with Pointier.
    borderRadius: restyled(radius.pill, radius.md),
    paddingHorizontal: spacing.lg,
    height: 44,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    paddingVertical: 0,
  },
  searchCancel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
  noResults: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  addBox: {
    width: 48,
    height: 48,
    backgroundColor: colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '500' },
  discHeader: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    marginTop: spacing.xs,
  },
  discHeaderText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  list: {
    paddingHorizontal: spacing.lg,
  },
  header: {
    paddingBottom: spacing.lg,
    gap: spacing.xs,
  },
  coverCenter: {
    alignItems: 'center',
    marginBottom: spacing.lg,
    // The big cover sits on the page rather than being printed on it: a soft
    // shadow under it and to the sides, less over the top. The offset is what
    // puts the weight at the bottom, and the radius what softens it - one
    // shadow, both edges handled. It fades out with the cover it belongs to.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
  },
  wideCover: {
    // No corners and no shadow: the picture is printed into the page itself,
    // from the very top edge, and the rows below come back into their inset.
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xxl,
    letterSpacing: tracking.display,
    fontWeight: '500',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    marginTop: spacing.xs,
  },
  subtitleLink: {
    color: colors.text,
    fontWeight: '500',
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
  },
  artistPhoto: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  // Same weight and colour as the metadata under it: what the playlist says
  // about itself belongs with the rest of what it says, not above it as a
  // second title.
  description: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    lineHeight: 20,
  },
  // Same text, same width, no paint: only here to count the lines.
  descriptionMeasure: {
    position: 'absolute',
    opacity: 0,
    pointerEvents: 'none',
    width: '100%',
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  // Under the text, never over it: the header sits on the dominant color
  // gradient, so a patch of the plain background would show as a rectangle.
  descriptionMore: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
  },
  descriptionMoreText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
  // The row keeps the gap the line used to keep for itself, so a header with
  // no badge sits exactly where it always did.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.xs,
  },
  meta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flexShrink: 1,
  },
  // `flexGrow: 0` or the row would stretch to fill the header column.
  genres: { flexGrow: 0, marginTop: spacing.sm },
  genresContent: { gap: spacing.sm, paddingRight: spacing.lg },
  genreChip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  genreText: { color: colors.textSecondary, fontSize: fontSize.xs },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  actionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  downloadWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  downloadProgress: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '500',
    minWidth: 32,
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  playButton: {
    backgroundColor: colors.accent,
    width: PLAY_SIZE,
    height: PLAY_SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The place the button takes in the header.
  playSlot: {
    width: PLAY_SIZE,
    height: PLAY_SIZE,
  },
  // The button over the bar: only the column's `right` comes with each
  // render; the scroll and the search row's height travel in wrappers.
  playDock: {
    position: 'absolute',
  },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  barTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  barTitleCentered: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    // Both ends come with each render (they need the screen's width): the same
    // clearance either side is what puts the name in the middle of the screen.
    textAlign: 'center',
    includeFontPadding: false,
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '500',
  },
}));

