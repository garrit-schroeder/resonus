/**
 * Floating action bar for multi-select, above the mini player and at the same
 * height as the toast. Shared so every screen with selection shows the same
 * bar in the same place: it lives here rather than in `TrackListView` because
 * screens that build their own list (a genre's songs) need it too.
 *
 * Three slots at most and the last is always ⋯ (#164): the bar keeps the two
 * actions worth a single tap on that screen and the sheet behind ⋯ holds the
 * rest, so a new action no longer has to win its slot off another. Nothing is
 * in both places: a row repeating a button right above it is a row to read and
 * discard. The one exception is a list whose rows were dragged (see the `reorder`
 * prop below): keeping the new order is something the hand did to the rows
 * themselves, not to what is marked, so it gets its own button in front of ⋯
 * and never competes for a slot.
 *
 * How high is not a number of its own but `useFloatingBottom`, which is what
 * "clear of the mini player while there is one, and of the navigation bar
 * where there is one" means in one place. It used to be a constant, and it was
 * 24 px short of the mini player once the navigation bar was on: the actions
 * were there and partly behind it, which is the combination people actually
 * run. Then it followed the padding the lists reserve, which always keeps the
 * mini player's room whether or not anything is playing, and on a quiet screen
 * left the bar floating with a hole under it.
 *
 * With nothing marked the actions stay visible but dimmed and disabled: they
 * say what selecting is FOR, which an empty bar wouldn't.
 */
import Icon from '@/components/Icon';
import { useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useFloatingBottom } from '@/hooks/useScreenBottomPadding';
import { useT } from '@/i18n';
import { colors, fontSize, radius, spacing, themed } from '@/theme';
import { SheetModal } from './SheetModal';

export interface SelectionAction {
  icon: keyof typeof Icon.glyphMap;
  label: string;
  onPress: () => void;
}

export function SelectionBar({
  actions,
  menu,
  count,
  reorder,
}: {
  /** Buttons on the bar, at most two: the rest of the room goes to ⋯. */
  actions: SelectionAction[];
  /** What goes behind ⋯, `actions` aside. Without any there is no ⋯ button. */
  menu?: SelectionAction[];
  count: number;
  /**
   * A list's rows may answer a hold by travelling; then the bar also carries
   *  the button that keeps what the hand has just arranged. It is not one of
   *  the two slots and not behind ⋯: it is the action the drag itself made,
   *  and the only one that ignores what is marked — an order belongs to the
   *  whole list. It stays visible and dimmed until a row actually moved, so
   *  the bar says what a drag is for, like an empty selection does.
   */
  reorder?: { action: SelectionAction; ready: boolean };
}) {
  const bottom = useFloatingBottom();
  const t = useT();
  const openMenu = useRef<() => void>(() => {});
  // Chosen in the sheet, run once it is off screen: an action clears the
  // selection, and that unmounts this bar with the sheet still inside it.
  const chosen = useRef<(() => void) | null>(null);

  const hasMenu = !!menu && menu.length > 0;
  const shown = actions.slice(0, hasMenu ? 2 : 3);
  if (shown.length === 0 && !hasMenu) return null;

  return (
    <>
      <View style={[styles.bar, { bottom }]}>
        {shown.map((a) => (
          <BarButton key={a.label} action={a} disabled={count === 0} onPress={a.onPress} />
        ))}
        {reorder ? (
          <BarButton
            action={reorder.action}
            disabled={!reorder.ready}
            onPress={reorder.action.onPress}
          />
        ) : null}
        {hasMenu ? (
          <BarButton
            action={{ icon: 'ellipsis-horizontal', label: t('More') }}
            disabled={count === 0}
            onPress={() => openMenu.current()}
          />
        ) : null}
      </View>
      {hasMenu ? (
        <SheetModal
          openRef={openMenu}
          onClosed={() => {
            const run = chosen.current;
            chosen.current = null;
            run?.();
          }}
        >
          {(close) => (
            <>
              {menu.map((a) => (
                <Pressable
                  key={a.label}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  onPress={() => {
                    chosen.current = a.onPress;
                    close();
                  }}
                >
                  <Icon name={a.icon} size={24} color={colors.text} />
                  <Text style={styles.rowText}>{a.label}</Text>
                </Pressable>
              ))}
            </>
          )}
        </SheetModal>
      ) : null}
    </>
  );
}

function BarButton({
  action,
  disabled,
  onPress,
}: {
  action: { icon: keyof typeof Icon.glyphMap; label: string };
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, (pressed || disabled) && { opacity: 0.5 }]}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      disabled={disabled}
      onPress={onPress}
    >
      <Icon name={action.icon} size={22} color={colors.onSnackbar} />
      <Text style={styles.label} numberOfLines={1}>
        {action.label}
      </Text>
    </Pressable>
  );
}

const styles = themed((colors) => ({
  bar: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    backgroundColor: colors.snackbar,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  label: {
    color: colors.onSnackbar,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowText: { color: colors.text, fontSize: fontSize.md },
}));
