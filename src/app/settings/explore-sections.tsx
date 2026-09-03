/**
 * Settings › Explore sections: the order of the pills at the top of Explore.
 *
 * The same draggable list the Home chips and the navigation bar use, without
 * the switches. Every other list here can be emptied and the thing it feeds
 * simply disappears; a section turned off would be a part of the catalogue with
 * no way in, and the tab already leaves out the ones the server has no answer
 * for (a Jellyfin account has no folder tree, offline there are no stations).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import ReorderableList, {
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';

import { ScreenHeader, SettingsSafeArea } from '@/components/SettingsUI';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { centredPadding, useScreenSize } from '@/hooks/useScreenSize';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { useSettings, type ExploreSection } from '@/store/settings';
import {
  colors,
  fontSize,
  radius,
  spacing,
  SCREEN_BOTTOM_PADDING,
  themed,
  useTheme,
} from '@/theme';

/** Each section's label, as an i18n key. The same ones the tab draws. */
const LABEL: Record<ExploreSection, string> = {
  playlists: 'Playlists',
  albums: 'Albums',
  artists: 'Artists',
  songs: 'Songs',
  genres: 'Genres',
  radio: 'Radio',
  folders: 'Folders',
};

function SectionRow({ section }: { section: ExploreSection }) {
  const t = useT();
  const drag = useReorderableDrag();
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
      <Text style={styles.label}>{t(LABEL[section])}</Text>
    </View>
  );
}

export default function ExploreSectionsSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  const { width } = useScreenSize();
  const t = useT();
  const sections = useSettings((s) => s.exploreSections);
  const setSections = useSettings((s) => s.setExploreSections);
  return (
    <SettingsSafeArea>
      <ScreenHeader title={t('Explore sections')} />
      {/* Every section is listed, including the ones this profile cannot reach:
          what is stored is a preference about any profile, and a Jellyfin
          account rearranging the list an offline one comes back to is the kind
          of surprise nobody asked for (#114). */}
      <Text style={styles.hint}>{t('Drag to reorder.')}</Text>
      <ReorderableList
        data={sections}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <SectionRow section={item} />}
        onReorder={({ from, to }: ReorderableListReorderEvent) => {
          const next = sections.slice();
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          setSections(next);
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
}));
