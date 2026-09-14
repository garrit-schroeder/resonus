/**
 * Settings › Home buttons: the icons at the top right of Home, and in what
 * order.
 *
 * The same draggable list as the navigation bar, with the same kind of
 * exemption: there, Home has no switch; here, the gear has none. Settings is
 * only reachable from that icon, so turning it off would leave no way back to
 * this very screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Switch, Text, View } from 'react-native';
import ReorderableList, {
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';

import { ScreenHeader, SettingsSafeArea } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { centredPadding, useScreenSize } from '@/hooks/useScreenSize';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { useSettings, type HomeButton, type HomeButtonKey } from '@/store/settings';
import {
  colors,
  fontSize,
  radius,
  spacing,
  SCREEN_BOTTOM_PADDING,
  themed,
  useTheme,
} from '@/theme';

/** What each row says and wears, so the list reads like the header does. */
const BUTTONS: Record<HomeButtonKey, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  search: { label: 'Search', icon: 'search-outline' },
  history: { label: 'History', icon: 'time-outline' },
  settings: { label: 'Settings', icon: 'settings-outline' },
};

function ButtonRow({ button }: { button: HomeButton }) {
  const t = useT();
  const drag = useReorderableDrag();
  const setHomeButton = useSettings((s) => s.setHomeButton);
  const accent = useAccent();
  const { label, icon } = BUTTONS[button.key];
  // The gear stays. Where it sits is a preference like any other; whether it
  // is there at all is not.
  const fixed = button.key === 'settings';
  return (
    <View style={styles.row}>
      <Pressable
        hitSlop={8}
        onPressIn={() => {
          haptic('medium');
          drag();
        }}
        accessibilityRole="button"
        accessibilityLabel={t('Reorder')}
      >
        <Ionicons name="reorder-two" size={24} color={colors.textSecondary} />
      </Pressable>
      <Ionicons name={icon} size={20} color={colors.textSecondary} />
      <Text style={styles.label}>{t(label)}</Text>
      {fixed ? (
        <Text style={styles.fixed}>{t('Always shown')}</Text>
      ) : (
        <Switch
          value={button.enabled}
          onValueChange={(v) => setHomeButton(button.key, v)}
          trackColor={{ false: colors.control, true: accent }}
          thumbColor={colors.knob}
        />
      )}
    </View>
  );
}

export default function HomeButtonsSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  const { width } = useScreenSize();
  const t = useT();
  const homeButtons = useSettings((s) => s.homeButtons);
  const setHomeButtons = useSettings((s) => s.setHomeButtons);
  return (
    <SettingsSafeArea>
      <ScreenHeader title={t('Home buttons')} />
      <Text style={styles.hint}>{t('Drag to reorder, toggle to show or hide.')}</Text>
      <ReorderableList
        data={homeButtons}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <ButtonRow button={item} />}
        onReorder={({ from, to }: ReorderableListReorderEvent) => {
          const next = homeButtons.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          setHomeButtons(next);
        }}
        contentContainerStyle={[
          styles.list,
          // Centred once the screen is wider than a list wants to be, like
          // every other settings screen (#131).
          { paddingBottom: bottomPad, paddingHorizontal: centredPadding(width, spacing.lg) },
        ]}
      />
    </SettingsSafeArea>
  );
}

const styles = themed((colors) => ({
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: SCREEN_BOTTOM_PADDING },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  label: { flex: 1, color: colors.text, fontSize: fontSize.md },
  // Where the switch would be, in the voice of something that is not a
  // control: it is an answer to "why can I not turn this one off".
  fixed: { color: colors.textMuted, fontSize: fontSize.xs },
}));
