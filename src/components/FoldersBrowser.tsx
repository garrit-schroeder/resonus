/**
 * The server's music folders, as the way into browsing its directory tree.
 *
 * Subsonic only, and it lived as a fourth segment of "Your library" until the
 * Explore tab gathered the whole catalogue in one place. What a folder holds
 * is the server's, not yours, which is what it was doing on the wrong side of
 * that line.
 *
 * A server that declares no libraries still has a tree, so it gets one root
 * entry rather than an empty screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import { getMusicFolders } from '@/api/data';
import { Message } from '@/components/Message';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useListPadding } from '@/hooks/useScreenSize';
import { useT } from '@/i18n';
import { listPerf } from '@/lib/listPerf';
import { useAuthStore } from '@/store/auth';
import { colors, fontSize, spacing, themed } from '@/theme';

export function FoldersBrowser() {
  const listPad = useListPadding(spacing.lg);
  const t = useT();
  const router = useRouter();
  const bottomPad = useScreenBottomPadding();
  const canFetch = useAuthStore((s) => !!s.auth);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['musicFolders'],
    queryFn: () => getMusicFolders(),
    enabled: canFetch,
  });
  if (isLoading) {
    return <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.accent} />;
  }
  if (isError) return <Message text={t("Couldn't load folders.")} onRetry={() => refetch()} />;
  const folders = data && data.length > 0 ? data : [{ id: 'root', name: t('Music') }];
  return (
    <FlatList
      {...listPerf}
      contentContainerStyle={[
        styles.list,
        { paddingBottom: bottomPad, paddingHorizontal: listPad },
      ]}
      data={folders}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() =>
            router.push({
              pathname: '/browse/folder/[id]',
              params: { id: item.id, name: item.name, root: '1' },
            })
          }
        >
          <Ionicons name="folder" size={44} color={colors.accent} />
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
        </Pressable>
      )}
    />
  );
}

const styles = themed((colors) => ({
  // A gap at the top the other sections get from their search box: without it
  // the first folder sits against the chips.
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowInfo: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
}));
