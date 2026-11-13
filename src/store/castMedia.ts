/**
 * Media session for casting mode (native module `modules/cast-media`).
 *
 * While casting via UPnP no local audio plays, so the expo-audio MediaSession
 * can't provide lock screen controls or capture volume buttons. This module
 * maintains its own session (notification + remote volume) during cast: here we
 * just push metadata/state and receive the controls the user presses, which the
 * player routes to the renderer.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule('CastMedia');

export interface CastNowPlaying {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
}

let sub: { remove: () => void } | undefined;
let handler: ((action: string, value?: number) => void) | null = null;

/** Registers the controls handler (play/pause/next/prev/seek/volume). */
export function initCastMedia(fn: (action: string, value?: number) => void): void {
  handler = fn;
  if (!native || sub) return;
  sub = native.addListener('command', (e: { action: string; value?: number }) => {
    handler?.(e.action, e.value);
  });
}

function payload(info: CastNowPlaying): string {
  return JSON.stringify({
    title: info.title ?? '',
    artist: info.artist ?? '',
    album: info.album ?? '',
    artworkUrl: info.artworkUrl ?? '',
    durationMs: Math.max(0, Math.round(info.durationMs)),
    positionMs: Math.max(0, Math.round(info.positionMs)),
    isPlaying: info.isPlaying,
  });
}

/** Refreshes metadata + state on track change. */
export function castUpdate(info: CastNowPlaying): void {
  try {
    native?.update(payload(info));
  } catch {
    // ignore
  }
}

/**
 * Syncs the remote volume shown by the system volume overlay (0..1). Without
 * this the native VolumeProviderCompat stayed at its initial 50% no matter the
 * real renderer volume.
 */
export function castSetVolumeLevel(volume: number): void {
  try {
    native?.setVolumeLevel(Math.max(0, Math.min(1, volume)));
  } catch {
    // ignore
  }
}

/** Refreshes only playback state (play/pause + progress). */
export function castSetState(isPlaying: boolean, positionMs: number): void {
  try {
    native?.setState(isPlaying, Math.max(0, Math.round(positionMs)));
  } catch {
    // ignore
  }
}

/** Closes the session and removes the notification. */
export function castStop(): void {
  try {
    native?.stop();
  } catch {
    // ignore
  }
}
