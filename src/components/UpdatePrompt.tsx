/**
 * Says that a newer Resonus is out, and installs it.
 *
 * The throttle lives in `checkForUpdate`, so asking here is cheap and this
 * asks on every occasion somebody could have come back to a newer release:
 * the launch, every return to the foreground, the moment the network comes
 * back, and a timer for the app left open. All four go through the same
 * throttled call, which turns them into "at most once every few hours".
 *
 * That list is the fix for a report that the switch did nothing. It used to be
 * the launch alone, once per process, and a music player's process outlives its
 * launches by days, so for anyone who never swipes the app away there was no
 * second occasion.
 *
 * The one state that stops all four is offline mode chosen by hand, which is
 * the only place anybody says "use no network" (#179). Not the app's offline
 * flag as a whole: that one is on for the local profile, where it means having
 * no music server rather than wanting no internet, and reading it as the latter
 * is what left those users never asked at all. Nor an automatic offline, where
 * the server is what stopped answering and the connection is very likely fine.
 *
 * Closing it asks again on the next round, and the switch in Settings › About
 * is the one that stops all of it. There is no per-version dismissal: a few
 * hours of quiet is short enough not to need one, and a release somebody said
 * no to once is the release they are still on when they report the bug it
 * fixed.
 *
 * The download has its own window rather than living in the dialog: 57 MB needs
 * a progress bar and a way out, and `Dialog` is built for a question.
 */
import { useEffect } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Pressable,
  Text,
  View,
} from 'react-native';

import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import { clearDownloadedApk, currentVersion, RELEASES_PAGE } from '@/lib/appUpdate';
import { useAuthStore } from '@/store/auth';
import { useNetworkType } from '@/store/networkType';
import { useSettings } from '@/store/settings';
import { useUpdate } from '@/store/update';
import { colors, fontSize, radius, spacing, themed } from '@/theme';
import { Dialog } from './Dialog';

/** Whether this launch has already cleaned up after the previous one. */
let swept = false;

/**
 * How often the app-left-open timer comes round. Not the throttle: that one is
 * in `checkForUpdate` and is what decides whether a tick does anything. This
 * only has to be short enough that a session spent inside the app crosses it,
 * and long enough to cost nothing when it doesn't.
 */
const TICK_MS = 30 * 60 * 1000;

export function UpdatePrompt() {
  const t = useT();
  const accent = useAccent();
  const enabled = useSettings((s) => s.updateCheck);
  const hydrated = useSettings((s) => s.hydrated);
  const cellular = useNetworkType((s) => s.cellular);
  const connected = useNetworkType((s) => s.connected);
  // Offline mode as an instruction rather than as a circumstance: a server
  // account whose owner pressed the button in Settings. The local profile
  // (`offline` with no account) and a fall to offline are both `offline` too,
  // and neither of them is somebody asking for radio silence.
  const byChoice = useAuthStore((s) => s.offline && !s.autoOffline && !!s.auth);
  const phase = useUpdate((s) => s.phase);
  const release = useUpdate((s) => s.release);
  const progress = useUpdate((s) => s.progress);
  const check = useUpdate((s) => s.check);
  const start = useUpdate((s) => s.start);
  const resume = useUpdate((s) => s.resume);
  const close = useUpdate((s) => s.close);

  // Whatever a previous run downloaded is 57 MB of somebody's storage, and by
  // now it has either been installed or given up on. Not tied to the switch:
  // the bytes are already spent and want clearing either way.
  useEffect(() => {
    if (swept) return;
    swept = true;
    clearDownloadedApk();
  }, []);

  // Only once the settings are read from disk: before that `updateCheck` is its
  // default (on), and someone who had turned it off would be checked on anyway.
  //
  // `connected` is in the dependencies rather than only in the guard, which is
  // what makes "the network came back" one of the occasions: the effect re-runs
  // on the change and the first thing it does is ask.
  useEffect(() => {
    if (!hydrated || !enabled || !connected || byChoice) return;
    void check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    const timer = setInterval(() => void check(), TICK_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [hydrated, enabled, connected, byChoice, check]);

  // The answer to «install unknown apps» is not returned to us: the system
  // screen is another app, and coming back is the only news we get.
  useEffect(() => {
    if (phase !== 'permission') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
    });
    return () => sub.remove();
  }, [phase, resume]);

  const version = release?.version;
  const megabytes = release?.size ? Math.round(release.size / 1_000_000) : 0;

  return (
    <>
      <Dialog
        visible={phase === 'offered' && !!version}
        title={t('Update available')}
        message={
          // The size only when it is somebody's data plan. On Wi-Fi it is a
          // number that answers a question nobody asked.
          //
          // The number goes in bare, with no `v` in front of it. That letter is
          // English shorthand and it was being glued on here, which made it
          // every language's whether they wanted it or not: a translator who
          // would rather write the word for "version" got "version v0.7.0" and
          // no way to do anything about it. Now the sentence decides, which is
          // where a decision about wording belongs.
          cellular && megabytes > 0
            ? t('Resonus {new} is out. You have {old}. The download is about {mb} MB.', {
                new: version ?? '',
                old: currentVersion(),
                mb: megabytes,
              })
            : t('Resonus {new} is out. You have {old}.', {
                new: version ?? '',
                old: currentVersion(),
              })
        }
        confirmLabel={t('Update')}
        neutral={{
          // What changed is the one thing that answers "should I?", and the
          // notes are written per release and far too long for a dialog. Not a
          // third answer to the question: it closes nothing, because reading
          // what changed and then pressing Update is the point of it. Same
          // words as the row in Settings › About that opens the same page.
          label: t("What's new"),
          // Otherwise it is one more grey line among grey lines, and nothing
          // says it is a place to go rather than something being told to you.
          icon: 'open-outline',
          onPress: () => void Linking.openURL(release?.pageUrl ?? RELEASES_PAGE),
        }}
        onCancel={close}
        onConfirm={start}
      />

      {/* Nothing to say while the system screen is open: it is on top of us and
          the prompt underneath would only be in the way when it closes. */}
      <Modal
        visible={phase === 'downloading'}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>
              {t('Downloading Resonus {version}', { version: version ?? '' })}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.round(progress * 100)}%`, backgroundColor: accent },
                ]}
              />
            </View>
            <View style={styles.status}>
              {/* Until the first bytes land there is no fraction to show, and a
                  bar sitting at zero reads as stuck. */}
              {progress > 0 ? (
                <Text style={styles.percent}>{`${Math.round(progress * 100)}%`}</Text>
              ) : (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={close}
              style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.cancelLabel}>{t('Cancel')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = themed((colors) => ({
  backdrop: {
    flex: 1,
    backgroundColor: colors.backdropStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: colors.accent },
  status: { minHeight: 20, justifyContent: 'center' },
  percent: { color: colors.textSecondary, fontSize: fontSize.sm },
  cancel: { alignSelf: 'flex-end', paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  cancelLabel: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: '600' },
}));
