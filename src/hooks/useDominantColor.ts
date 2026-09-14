/**
 * Extracts a background color from the cover art (dominant color) and
 * normalizes it to a pleasant tone: saturation is clamped (to avoid neon) and
 * lightness is clamped to a narrow band, so that text and controls are always
 * legible regardless of the cover art. This is what Spotify/Apple Music do with
 * the cover color.
 *
 * Which band depends on the appearance: medium-dark under the dark theme, pale
 * under the light one. The tint has to be a shade of the page it sits on — a
 * dark tinted bar in the middle of a white app is not a tint, it is a hole —
 * and keeping it on the right side of the line is also what lets every screen
 * using it go on writing over it in the ordinary text colour.
 */
import { useEffect, useState } from 'react';

import { CACHED_COVER, COVER } from '@/api/data';
import { colors as theme, useThemeMode, type ThemeMode } from '@/theme';

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue(h + 1 / 3);
    g = hue(h);
    b = hue(h - 1 / 3);
  }
  const to = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Saturation of a hex color in HSL, or -1 if it cannot be read. */
function saturationOf(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return -1;
  return rgbToHsl(rgb[0], rgb[1], rgb[2])[1];
}

/**
 * Picks the accent from the four colors iOS returns.
 *
 * They come labeled by role, not by vibrancy: `background` is the dominant
 * area of the cover and `primary`, `secondary` and `detail` are the foreground
 * ones in order of how much of the cover they take. The dominant area is the
 * one that reads as "the color of this cover", so it wins whenever it carries
 * any color at all; the covers it fails on are the ones whose dominant area is
 * a white border or a black void, and there the foreground colors are all
 * there is. Among those, order beats saturation unless the gap is wide: a
 * small vivid detail should not push aside the color the cover is made of.
 */
function pickIosColor(
  background: string | undefined,
  primary: string | undefined,
  secondary: string | undefined,
  detail: string | undefined,
): string | undefined {
  const NEUTRAL = 0.15;
  const CLEARLY_MORE = 1.5;

  if (background && saturationOf(background) >= NEUTRAL) return background;

  let best: string | undefined;
  let bestSat = 0;
  for (const hex of [primary, secondary, detail]) {
    if (!hex) continue;
    const s = saturationOf(hex);
    if (s < NEUTRAL) continue;
    if (!best || s >= bestSat * CLEARLY_MORE) {
      best = hex;
      bestSat = s;
    }
  }

  return best || background;
}

/**
 * Clamps saturation and lightness into the readable band for the appearance.
 *
 * The light band is narrower and sits high (0.88–0.94): a pale wash keeps the
 * hue of the cover while leaving black text on it at well over the contrast the
 * dark band gives white text. Saturation is allowed a little further up there
 * because at that lightness a clamp of 0.55 comes out as grey.
 */
function normalize(hex: string, mode: ThemeMode): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  if (mode === 'light') {
    return hslToHex(h, Math.min(s, 0.7), Math.min(Math.max(l, 0.88), 0.94));
  }
  return hslToHex(h, Math.min(s, 0.55), Math.min(Math.max(l, 0.2), 0.32));
}

/**
 * Size asked for when the image is only going to be reduced to one colour.
 *
 * `getColors` downloads on its own — it doesn't share expo-image's cache — so
 * asking for the same 500 or 600 px the screen is already showing meant
 * fetching every cover twice at full size. A small copy quantizes to the same
 * colour for a fraction of the bytes.
 *
 * It's also one single size across the app: the player and the mini player had
 * to agree on one already, or the same song came out two different colours on
 * two screens. Now everything reads the same pixels.
 */
const PALETTE_SIZE = COVER.thumb;

/** The same cover, small, when it's a server cover URL — Subsonic asks for
 *  `size`, Jellyfin for `fillWidth`/`fillHeight`. Anything else (local files,
 *  radio art) is left exactly as it is. */
function paletteUri(uri: string): string {
  return uri.replace(/([?&](?:size|fillWidth|fillHeight)=)\d+/g, `$1${PALETTE_SIZE}`);
}

export function useDominantColor(uri?: string): string {
  const [color, setColor] = useState<string>(theme.surfaceHighlight);
  // Switching appearance re-runs the whole thing: the palette `getColors`
  // returns is cached, so this is a second pass through `normalize` and not a
  // second download.
  const mode = useThemeMode();

  useEffect(() => {
    let active = true;
    // A cover marked as cache-only (offline, see `CACHED_COVER`) is not a URL
    // and is not ours to fetch: `getColors` downloads on its own, so it would
    // be exactly the request offline mode is there to avoid. The tint stays the
    // plain one, which is what a cover nobody can see should look like.
    if (!uri || uri.startsWith(CACHED_COVER)) {
      setColor(theme.surfaceHighlight);
      return;
    }
    const src = paletteUri(uri);
    // Keyed by the small URL: two screens showing the same cover at different
    // sizes now share one cached palette. `quality` is read on iOS only, where
    // it decides how much of the image is looked at before averaging, and the
    // URL above already brought the cover down to `PALETTE_SIZE`, so there is
    // nothing to save by looking at less than all of it.
    import('react-native-image-colors')
      .then(({ getColors }) =>
        getColors(src, {
          fallback: theme.surfaceHighlight,
          cache: true,
          key: src,
          quality: 'high',
        }),
      )
      .then((res) => {
        if (!active || !res) return;
        let c: string = theme.surfaceHighlight;
        if (res.platform === 'android') {
          c = res.vibrant || res.darkVibrant || res.muted || res.dominant || c;
        } else if (res.platform === 'ios') {
          c = pickIosColor(res.background, res.primary, res.secondary, res.detail) || c;
        } else if (res.platform === 'web') {
          c = res.vibrant || res.darkVibrant || res.dominant || c;
        }
        setColor(normalize(c, mode));
      })
      .catch(() => {
        if (active) setColor(theme.surfaceHighlight);
      });
    return () => {
      active = false;
    };
  }, [uri, mode]);

  return color;
}
