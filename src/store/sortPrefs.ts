/**
 * Sort preference (field + direction) per list, persisted on disk.
 * The key identifies the list ('favorites', 'playlist:<id>'…); the default
 * sort is not saved so the map only contains what the user changed.
 */
import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';

const KEY = 'resonus.sortPrefs';

/** What a list of songs can be ordered by (see `useSongSort`). */
export type SongSortField = 'recent' | 'added' | 'alpha' | 'artist' | 'album' | 'downloaded';
/** And a list of albums (see `useAlbumSort`); 'alpha' means the same there. */
export type AlbumSortField = 'year' | 'alpha';
/** Anything this map can hold: one store keeps the choice made on every list. */
export type SortField = SongSortField | AlbumSortField;
export type SortDir = 'asc' | 'desc';

export interface SortPref {
  field: SortField;
  dir: SortDir;
}

export const DEFAULT_SORT: SortPref = { field: 'recent', dir: 'asc' };

interface SortPrefsState {
  prefs: Record<string, SortPref>;
  hydrated: boolean;
  /** `def` = default sort for that list (to omit from the map if it matches). */
  setPref: (key: string, pref: SortPref, def?: SortPref) => void;
  hydrate: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(prefs: Record<string, SortPref>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void setItem(KEY, JSON.stringify(prefs));
  }, 1000);
}

export const useSortPrefs = create<SortPrefsState>((set, get) => ({
  prefs: {},
  hydrated: false,

  setPref: (key, pref, def = DEFAULT_SORT) => {
    const prefs = { ...get().prefs };
    // Only omit from the map if it matches the real default for that list (which
    // for playlists is not the global one): otherwise, selecting the sort that
    // happened to match the global was read as "go back to default" and wasn't
    // saved.
    if (pref.field === def.field && pref.dir === def.dir) delete prefs[key];
    else prefs[key] = pref;
    set({ prefs });
    scheduleSave(prefs);
  },

  hydrate: async () => {
    try {
      const raw = await getItem(KEY);
      set({ prefs: raw ? (JSON.parse(raw) as Record<string, SortPref>) : {}, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
}));
