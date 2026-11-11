import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MINI_PLAYER_GAP, MINI_PLAYER_HEIGHT, spacing } from '@/theme';
import { useMiniPlayerShown, useTabBarBottom, useTabBarHeight, useTabBarShown } from './useTabBar';

/**
 * Bottom space that a list or scroll view must reserve to avoid being covered
 * by the floating MiniPlayer (and, where there is one, by the navigation bar).
 *
 * Replaces the fixed SCREEN_BOTTOM_PADDING constant, which ignored the bottom
 * safe area: with 3-button navigation (or large screens/fonts) that inset grows
 * and the MiniPlayer would end up covering the last item.
 *
 * The calculation mirrors the MiniPlayer position in `GlobalMiniPlayer`: above
 * the navigation bar wherever there is one, and at the bottom otherwise.
 */
export function useScreenBottomPadding(): number {
  const insets = useSafeAreaInsets();
  const withBar = useTabBarShown();
  const barHeight = useTabBarHeight();
  const barBottom = useTabBarBottom();
  const miniBottom = withBar ? barHeight + MINI_PLAYER_GAP + barBottom : insets.bottom + spacing.sm;
  return miniBottom + MINI_PLAYER_HEIGHT + spacing.md;
}

/**
 * Where something that floats over the screen has to sit: the toast and the
 * multi-select bar. Unlike the padding above, which reserves the MiniPlayer's
 * room whether or not anything is playing so a list doesn't reflow the moment
 * a song starts, this follows what is actually down there. A bar hanging 72 px
 * up in the air over an empty screen is the whole reason it isn't the same
 * number.
 */
export function useFloatingBottom(): number {
  const insets = useSafeAreaInsets();
  const withBar = useTabBarShown();
  const withMini = useMiniPlayerShown();
  const barHeight = useTabBarHeight();
  const barBottom = useTabBarBottom();
  const base = withBar ? barHeight + MINI_PLAYER_GAP + barBottom : insets.bottom + spacing.sm;
  return base + (withMini ? MINI_PLAYER_HEIGHT + spacing.md : spacing.md);
}
