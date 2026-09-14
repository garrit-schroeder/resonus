/**
 * Settings › Diagnostics: what has been keeping the JS thread busy.
 *
 * Reachable by tapping the version five times in About, because it is for
 * chasing a report, not for browsing. The share button hands over the same
 * thing as plain text, which is easier to paste into an issue than a
 * screenshot is to read.
 */
import Constants from 'expo-constants';
import { useRootNavigationState } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Share, Text, View } from 'react-native';

import { COVER, songCoverUrl, songListSorts } from '@/api/data';
import { SettingRow, SettingsPage, settingsStyles } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { coverSourceOf, mirrorCoverState } from '@/lib/mirrorCovers';
import {
  perfAway,
  perfBlocks,
  perfCounts,
  perfOps,
  perfReport,
  perfSince,
  resetPerfLog,
} from '@/lib/perfLog';
import { repairStatus } from '@/lib/navidromeRepair';
import { useAuthStore } from '@/store/auth';
import { anyDownloads, useDownloads } from '@/store/downloads';
import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { enabledFolderIds } from '@/store/libraries';
import { fontSize, spacing, themed, useTheme } from '@/theme';

/** Stamped in by the workflow that builds the APK; empty when run locally. */
const COMMIT = (process.env.EXPO_PUBLIC_COMMIT ?? '').slice(0, 7);

export default function DiagnosticsSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  // Nothing here is reactive: it is a snapshot, refreshed by pulling or by
  // resetting, so reading it doesn't add work of its own.
  const [tick, setTick] = useState(0);
  const blocks = perfBlocks();
  // What the profile is, in the terms the code asks about it. Half the reports
  // that start with "this doesn't show up for me" end here.
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const folderFilter = enabledFolderIds(auth);
  const profileLines = [
    // Which build this is, since a test APK carries the same version as the
    // release it was branched from and there is otherwise no telling them
    // apart from inside the app.
    `build: ${Constants.expoConfig?.version ?? '?'}${COMMIT ? ` (${COMMIT})` : ' (local)'}`,
    `type: ${auth?.serverType ?? '—'}`,
    `native password: ${auth?.ndPassword || auth?.password ? 'yes' : 'no'}`,
    `plain auth: ${auth?.plainAuth ? 'yes' : 'no'}`,
    `library filter: ${folderFilter ? folderFilter.join(', ') : 'none'}`,
    `offline: ${offline ? 'yes' : 'no'}`,
    // Navidrome 0.64 renumbers every id and this is what repaired it. Silent
    // everywhere else, so this line is the only way to tell what it did.
    `id repair: ${repairStatus()}`,
    `song sorts: ${(auth || offline ? songListSorts() : []).join(', ') || '—'}`,
  ];
  const ops = perfOps();
  const away = perfAway();
  const counts = perfCounts();
  const enabled = useSettings((s) => s.diagnostics);
  const covers = mirrorCoverState();
  const downloads = useDownloads((s) => Object.keys(s.files).length);
  const hydrated = useDownloads((s) => s.hydrated);
  const anyDl = useDownloads(anyDownloads);
  // How deep the stack is. Screens you left stay mounted, which is what makes
  // going back instant and what made the app slow down the more you opened
  // before they were frozen: a number here would have said so in a sentence.
  const navState = useRootNavigationState();
  /**
   * How the cover of what is playing was arrived at.
   *
   * A wrong cover over the right title is not the queue being wrong, it is the
   * picture being looked up by an id that leads somewhere else. Three things
   * can happen and the app kept no record of which: the file saved under this
   * very id, a file saved under ANOTHER id that this one borrows, or nothing
   * local and the server asked directly. Only the middle one can hand back a
   * picture that belongs to something else, so the id it borrowed from is the
   * answer.
   *
   * `coverId` is worked out the way `songCoverUrl` works it out, which is the
   * whole point: reading a different id here would describe a lookup nobody
   * made.
   */
  const playing = usePlayerStore(currentSong);
  const coverId = playing
    ? (playing.coverArt ?? (playing.url ? undefined : playing.albumId))
    : undefined;
  const coverUrl = playing ? songCoverUrl(playing, COVER.card) : undefined;
  const coverLines = playing
    ? [
        `playing: ${playing.title}${playing.album ? ` · ${playing.album}` : ''}`,
        `cover id: ${coverId ?? '—'} (${coverSourceOf(coverId)})`,
        `cover from: ${
          coverUrl
            ? coverUrl.startsWith('file://')
              ? `file ${coverUrl.split('/').pop()}`
              : 'the server'
            : 'nothing'
        }`,
        `song ids: coverArt ${playing.coverArt ?? '—'} · album ${playing.albumId ?? '—'}`,
      ]
    : [];
  const stateLines = [
    `downloads: ${hydrated ? downloads : 'loading'}${anyDl && !hydrated ? ' (some)' : ''}`,
    `mirror covers: ${covers.saved} saved, ${covers.aliases} other names`,
    `screens open: ${navState?.routes?.length ?? '—'}`,
    ...coverLines,
  ];
  const minutes = Math.max(1, Math.round((Date.now() - perfSince()) / 60000));

  return (
    <SettingsPage title={t('Diagnostics')}>
      <ScrollView
        contentContainerStyle={settingsStyles.content}
        // Any scroll refreshes the numbers; no timer polling behind this.
        onScrollEndDrag={() => setTick(tick + 1)}
      >
        <Text style={settingsStyles.sectionDescription}>
          {enabled
            ? t('Measured over the last {n} min of use.', { n: minutes })
            : t('Measuring is off (Settings › About), so there is nothing to show.')}
        </Text>

        <Text style={settingsStyles.sectionTitle}>{t('Profile')}</Text>
        {profileLines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}

        <Text style={settingsStyles.sectionTitle}>{t('State')}</Text>
        {stateLines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}

        <Text style={settingsStyles.sectionTitle}>{t('Interface freezes')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t('Moments when the app stopped responding, longest first.')}
        </Text>
        {blocks.length === 0 ? (
          <Text style={styles.line}>{t('None over 120 ms.')}</Text>
        ) : (
          blocks.map((b, i) => (
            <Text key={i} style={styles.line}>
              {b.ms} ms · {b.during}
            </Text>
          ))
        )}

        <Text style={settingsStyles.sectionTitle}>{t('Time spent')}</Text>
        {ops.length === 0 ? (
          <Text style={styles.line}>{t('Nothing measured yet.')}</Text>
        ) : (
          ops.slice(0, 20).map((o) => (
            <View key={o.tag} style={styles.row}>
              <Text style={styles.tag} numberOfLines={1}>
                {o.tag}
              </Text>
              <Text style={styles.value}>
                {o.count}× · {o.totalMs} ms · {o.maxMs} ms
              </Text>
            </View>
          ))
        )}

        {away.length > 0 ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('While minimized')}</Text>
            <Text style={settingsStyles.sectionDescription}>
              {t(
                'The player keeps beating twice a second while the app is away. Long silences here mean the app stopped following what it was playing.',
              )}
            </Text>
            {away.map((a) => (
              <View key={a.tag} style={styles.row}>
                <Text style={styles.tag} numberOfLines={2}>
                  {a.tag}
                </Text>
                <Text style={styles.value}>
                  {a.count}× · {a.maxMs} ms
                </Text>
              </View>
            ))}
          </>
        ) : null}

        {counts.length > 0 ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Counted')}</Text>
            <Text style={settingsStyles.sectionDescription}>
              {t('What happened, rather than how long it took.')}
            </Text>
            {counts.map((c) => (
              <View key={c.tag} style={styles.row}>
                <Text style={styles.tag} numberOfLines={1}>
                  {c.tag}
                </Text>
                <Text style={styles.value}>{c.n}</Text>
              </View>
            ))}
          </>
        ) : null}

        <SettingRow
          icon="share-outline"
          label={t('Share report')}
          onPress={() =>
            void Share.share({
              message: `${profileLines.join('\n')}\n${stateLines.join('\n')}\n\n${perfReport()}`,
            })
          }
        />
        <SettingRow
          icon="refresh"
          label={t('Start over')}
          onPress={() => {
            resetPerfLog();
            setTick(tick + 1);
          }}
        />
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  line: { color: colors.textSecondary, fontSize: fontSize.sm, paddingVertical: 2 },
  row: { flexDirection: 'row', gap: spacing.md, paddingVertical: 2 },
  tag: { color: colors.text, fontSize: fontSize.sm, flex: 1 },
  value: { color: colors.textSecondary, fontSize: fontSize.sm },
}));
