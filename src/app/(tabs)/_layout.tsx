/**
 * Main tab navigation. Which tabs, and in what order, is the user's
 * (Settings › Appearance › Navigation bar).
 * Solid bottom bar over the app background.
 *
 * With "Always show the navigation bar" on, the drawing is handed over to
 * `GlobalTabBar`, which sits next to the Stack and so can stay on screen
 * outside the tabs too. One bar either way: two would have to be kept looking
 * identical by hand, and the handover between them showed as a blink of empty
 * space in the middle of every back animation.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { type TabSegment } from '@/lib/tabOrigin';
import { useSettings } from '@/store/settings';
import { colors, TAB_BAR_HEIGHT, useTheme } from '@/theme';

/**
 * The icon each tab wears, beside the name it goes by (`TABS`). Two halves of
 * the same answer, kept apart because the name is also what the other bar and
 * the back arrow read, and neither of those draws an icon.
 */
const TAB_OPTIONS: Record<TabSegment, { label: string; icon: 'home' | 'search' | 'library' | 'albums' }> = {
  index: { label: 'Home', icon: 'home' },
  search: { label: 'Search', icon: 'search' },
  library: { label: 'Your library', icon: 'library' },
  explore: { label: 'Explore', icon: 'albums' },
};

export default function TabsLayout() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const alwaysShowTabs = useSettings((s) => s.alwaysShowTabs);
  const bottomTabs = useSettings((s) => s.bottomTabs);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Tabs
        // `undefined` leaves the navigator's own bar in place; the global one
        // draws nothing while that is the case.
        tabBar={alwaysShowTabs ? () => null : undefined}
        screenOptions={{
          headerShown: false,
          // The tab you are not on stops re-rendering, and its views come off
          // the screen, until you go back to it (the root layout does the same
          // for the stack). A tab is never unmounted once opened, so without
          // this every one you have visited keeps re-rendering for the rest of
          // the session, and Search, which lays out the whole genre list at
          // once, was making every screen change slower from the first visit
          // on.
          //
          // It costs the tabs their crossfade, and that is not a preference:
          // asking for any animation here hands the navigator an animated value
          // where it expects the number 0 or 2, and the comparison that decides
          // whether to freeze can only come out false. So an 80 ms fade turned
          // the whole thing off, quietly, from the day it was added. Whoever
          // wants it back has to check that freezing still happens.
          freezeOnBlur: true,
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.textSecondary,
          sceneStyle: { backgroundColor: colors.background },
          tabBarStyle: {
            position: 'absolute',
            backgroundColor: colors.background,
            borderTopWidth: 0,
            elevation: 0,
            height: TAB_BAR_HEIGHT + insets.bottom,
            paddingTop: 6,
            paddingBottom: insets.bottom,
          },
        }}
      >
        {/* Declared in the order the user put them in, because that is what
            sets the order on screen (`getSortedChildren`), and `href: null` is
            what hides one. A tab that is off keeps its route: anything already
            pointing at it still opens it. */}
        {bottomTabs.map(({ key, enabled }) => {
          const tab = TAB_OPTIONS[key];
          return (
            <Tabs.Screen
              key={key}
              name={key}
              options={{
                title: t(tab.label),
                href: enabled ? undefined : null,
                tabBarIcon: ({ focused, color, size }) => (
                  <Ionicons
                    name={focused ? tab.icon : `${tab.icon}-outline`}
                    color={color}
                    size={size}
                  />
                ),
              }}
            />
          );
        })}
      </Tabs>
    </View>
  );
}
