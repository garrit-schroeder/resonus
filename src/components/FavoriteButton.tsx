/** Heart to mark/unmark favorites (Subsonic star/unstar). */
import Icon from '@/components/Icon';
import { useEffect, useState } from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';

import { star, unstar, type StarType } from '@/api/data';
import { togglePodcastHeart } from '@/api/podcasts';
import { applyStarChange, resyncFavorites, unstarWithUndo } from '@/lib/favoritesCache';
import { haptic } from '@/lib/haptics';
import { useAuthStore } from '@/store/auth';
import { usePins } from '@/store/pins';
import { useToast } from '@/store/toast';
import { useT } from '@/i18n';
import { colors } from '@/theme';

interface Props {
  id: string;
  type?: StarType;
  starred?: boolean;
  size?: number;
  /** Song lists only: take the favourite off behind an «Undo» toast (#98). */
  undo?: boolean;
  /**
   * What holding the heart does: opens the sheet that adds the song to a
   * playlist, and nothing is asked of the favourite. Only the screens that
   * have such a sheet and a song that can go into one pass it; a heart in a
   * song list passes nothing and stays a tap.
   *
   * Offering it is also what makes React Native swallow the tap that comes
   * with a hold: `Pressability` cancels `onPress` once the press reached its
   * long-press state, so a hold never reads as an un-favourite (#286).
   */
  hold?: () => void;
  /**
   * Podcasts keep their hearts in SQLite, not the server's starring. The heart
   * behaves the same — it lights, it is guarded against a double tap, it toasts
   * — but the tap writes the device's own favorite and refreshes the podcast
   * lists instead of asking a server. `kind` says whether the id is a show or
   * one of its episodes; `channelId` is the show either way.
   */
  podcast?: { kind: 'channel' | 'episode'; channelId: string };
}

export function FavoriteButton({ id, type = 'song', starred, size = 22, undo, podcast, hold: onHold }: Props) {
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const t = useT();
  const toast = useToast((s) => s.show);
  const [fav, setFav] = useState(!!starred);
  const [busy, setBusy] = useState(false);

  // Resync with the current song: the same component is reused when switching
  // tracks (mini-player/player), so without this the heart would stay "stuck"
  // to the previous song's state.
  useEffect(() => {
    setFav(!!starred);
  }, [id, starred]);

  async function toggle(e?: GestureResponderEvent) {
    e?.stopPropagation();
    if (busy) return;
    // Podcasts: the heart is the device's own, filed in SQLite. Same feel —
    // optimistic light, a guard against a double tap, a toast — but the tap
    // writes the SQLite favorite and refreshes the podcast lists, no server.
    if (podcast) {
      haptic('medium');
      const nextFav = !fav;
      setFav(nextFav); // optimistic update
      setBusy(true);
      try {
        await togglePodcastHeart(id, podcast.kind, podcast.channelId);
        toast(nextFav ? t('Added to favorites') : t('Removed from favorites'));
      } catch {
        setFav(!nextFav); // revert on failure
        toast(t("Couldn't complete the action"));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!auth && !offline) return;
    haptic('medium');
    // In a song list the heart is small and sits where a finger scrolls, so
    // taking a favourite off waits behind «Undo» and nothing is asked of the
    // server until the toast goes. On the player, an artist or an album it is
    // a deliberate tap on a screen about that one thing: it goes out at once.
    if (fav && undo) {
      setFav(false);
      unstarWithUndo(type, id, () => setFav(true));
      return;
    }
    const nextFav = !fav;
    setFav(nextFav); // optimistic update
    setBusy(true);
    try {
      if (nextFav) await star(id, type);
      else await unstar(id, type);
      // Only the id is known here, so removing is exact and adding leaves the
      // list to refresh when something needs it (see `favoritesCache`).
      applyStarChange(type, id, nextFav);
      // Albums are only listed as favourites, so the pin would outlive the row.
      if (!nextFav && type === 'album') usePins.getState().unpin(`album:${id}`);
      toast(nextFav ? t('Added to favorites') : t('Removed from favorites'));
    } catch {
      setFav(!nextFav); // revert on failure
      resyncFavorites();
      toast(t("Couldn't complete the action"));
    } finally {
      setBusy(false);
    }
  }

  /** What a hold does: the caller's action, and nothing else. The favourite
   *  stays exactly as it was: React Native drops the tap that comes with a
   *  hold once a long-press handler is offered (see `hold`). The stop is what
   *  keeps the mini player's card, which opens the player when pressed, from
   *  answering under the finger. No session, no sheet: it is mounted only with
   *  one (`_layout.tsx`), same as the tap's guard above. */
  function held(e: GestureResponderEvent) {
    e.stopPropagation();
    if (!auth && !offline) return;
    haptic('medium');
    onHold?.();
  }

  return (
    <Pressable
      hitSlop={10}
      onPress={toggle}
      // Where nothing was offered, a hold stays a tap: the tap of a hold is
      // only dropped by React Native when a long-press handler is here at all.
      onLongPress={onHold ? held : undefined}
      accessibilityRole="button"
      accessibilityLabel={fav ? t('Remove from favorites') : t('Add to favorites')}
    >
      <Icon
        name={fav ? 'heart' : 'heart-outline'}
        size={size}
        color={fav ? colors.accent : colors.textSecondary}
      />
    </Pressable>
  );
}
