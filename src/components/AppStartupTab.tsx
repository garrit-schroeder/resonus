/**
 * Startup tab + reset on reopen.
 *
 * - On cold start, if the default tab is not Home, jump to it.
 * - On returning from background after a while (RESET_AFTER_MS), dismiss any
 *   stacked screens and go back to the default tab (like Spotify/YouTube).
 *   A brief app switch preserves where you were.
 * - Except the player: whoever left from it comes back to it, however long it
 *   was. The music is still there, and so is the reason they were looking at
 *   it; that is not a screen anyone forgot they had open.
 *
 * Renders nothing; only orchestrates navigation. Mounted with an active session.
 */
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { mark } from '@/lib/perfLog';
import { useAutoDownloads } from '@/store/autoDownloads';
import { useSettings, type DefaultTab } from '@/store/settings';

const TAB_HREF: Record<DefaultTab, '/' | '/search' | '/library' | '/explore'> = {
  index: '/',
  search: '/search',
  library: '/library',
  explore: '/explore',
};

// Time in background after which, on return, the app opens on the default
// tab. Below this (quick app switch) the current screen is preserved.
const RESET_AFTER_MS = 3 * 60 * 1000;

// The player and the two screens that open from it (the queue, the lyrics).
// Leaving from any of them is leaving from the player, and the reset above
// does not apply.
const PLAYER_PATHS = new Set(['/player', '/queue', '/lyrics']);

export function AppStartupTab() {
  const router = useRouter();
  const chosenTab = useSettings((s) => s.defaultTab);
  const bottomTabs = useSettings((s) => s.bottomTabs);
  /**
   * The tab to open on, which is not always the one that was chosen: it can
   * have been taken off the bar since (Settings › Navigation bar). Opening on
   * a screen with no way back to it is worse than opening on the first one
   * that is there, and Home always is.
   */
  const defaultTab = bottomTabs.some((t) => t.key === chosenTab && t.enabled)
    ? chosenTab
    : 'index';
  const backgroundedAt = useRef<number | null>(null);
  const didInitial = useRef(false);
  // Where the app was when it went away. Read in the listener, which has no
  // render of its own to take the value from.
  const pathname = usePathname();
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);

  /**
   * How long the thread takes to come back after a screen changes.
   *
   * This is the number everybody has been arguing about and nobody had: the
   * complaint is "half a second between tapping and the screen being there",
   * and everything measured so far has been how long single operations take,
   * which is not the same thing.
   *
   * The clock starts when the route changes and stops on the next frame the
   * thread manages to run, so what it counts is the new screen's first render
   * plus whatever else was in the way. It says nothing about the animation:
   * that is native, and if this number comes back small while the app still
   * feels slow, the animation is where to look next.
   *
   * By section rather than by route, or every album would be a line of its own.
   */
  useEffect(() => {
    const started = Date.now();
    const section = pathname === '/' ? '/' : `/${pathname.split('/')[1] ?? ''}`;
    const frame = requestAnimationFrame(() => mark(`nav ${section}`, Date.now() - started));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
  const leftFromPlayer = useRef(false);

  const goToDefaultTab = () => {
    // Dismiss whatever was stacked on top of the tabs (album, settings,
    // player…) and activate the default tab.
    if (router.canDismiss()) router.dismissAll();
    router.navigate(TAB_HREF[defaultTab]);
  };

  // Cold start: if the default tab is not Home, jump to it.
  useEffect(() => {
    if (didInitial.current) return;
    didInitial.current = true;
    if (defaultTab !== 'index') goToDefaultTab();
    // On mount only; the value lives in the guard ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        if (backgroundedAt.current === null) {
          backgroundedAt.current = Date.now();
          leftFromPlayer.current = PLAYER_PATHS.has(path.current);
        }
      } else if (state === 'active') {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        // The path is checked again here as well: a tap on the media
        // notification opens the player through a deep link, and that arrives
        // around now, with the app already coming back.
        const player = leftFromPlayer.current || PLAYER_PATHS.has(path.current);
        leftFromPlayer.current = false;
        if (since !== null && !player && Date.now() - since > RESET_AFTER_MS) goToDefaultTab();
        // On return, sync auto-download playlists (catch what was added from
        // another client while the app was in the background).
        void useAutoDownloads.getState().reconcileAll();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTab]);

  return null;
}
