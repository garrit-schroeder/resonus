/**
 * Self-contained bottom sheet: its visibility lives here and is opened
 * imperatively via `openRef`, so showing/hiding it does NOT re-render the
 * screen (with its list) that declares it — with state in the screen, opening
 * the menu had a noticeable delay. The content comes as a function receiving
 * `close` to close after choosing an action.
 *
 * Slides up and down and closes with a swipe, like the song menu: these menus
 * open the same way and from the same ⋯, so they behave the same way too.
 */
import { type MutableRefObject, type ReactNode, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBottomSheetAnim } from '@/hooks/useBottomSheetAnim';
import { SHEET_MAX_WIDTH, spacing, themed } from '@/theme';

export function SheetModal({
  openRef,
  children,
}: {
  /** The screen holds a ref and calls `openRef.current()` to open. */
  openRef: MutableRefObject<() => void>;
  children: (close: () => void) => ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  openRef.current = () => setOpen(true);
  const closeNow = () => setOpen(false);
  const { dismiss, pan, backdropStyle, sheetStyle, onSheetLayout } = useBottomSheetAnim(
    open,
    closeNow,
  );
  // The sheet slides down and only then is the Modal unmounted. Actions close
  // through here, so choosing one looks the same as swiping it away.
  const close = () => dismiss(closeNow);

  return (
    <Modal transparent animationType="none" visible={open} onRequestClose={close}>
      {/* Gestures inside an RN Modal need a root view of their own: the Modal
          renders in a native hierarchy outside the app's. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>
        {/* One drag around everything: what goes in here is a short list of
            actions that never scrolls, so nothing else competes for the
            gesture (the song menu needs two because its list does scroll). */}
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }, sheetStyle]}
            onLayout={onSheetLayout}
          >
            {/* Spotify-style grabber: the visual cue that the sheet can be
                dragged down to dismiss. */}
            <View style={styles.grabber} />
            {children(close)}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = themed((colors) => ({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.backdrop },
  sheet: {
    position: 'absolute',
    bottom: 0,
    // Centred and no wider than a sheet wants to be (#131).
    alignSelf: 'center',
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
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
}));
