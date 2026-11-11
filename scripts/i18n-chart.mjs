#!/usr/bin/env node
/**
 * Draws how far each language has got as one SVG, for the README.
 *
 *   node scripts/i18n-chart.mjs <file.svg>
 *
 * Not committed to main: a translator editing one JSON file would otherwise have
 * to regenerate it. `.github/workflows/i18n-chart.yml` publishes it to its own
 * branch. Percentages are the ones `pnpm i18n:status` gives.
 */
import { writeFileSync } from 'node:fs';

import { analyze, locales, todoKeys } from './i18n-lib.mjs';

const ROW = 26;
const NAME_W = 170;
const BAR_W = 300;
const WIDTH = NAME_W + BAR_W + 110;

const names = new Intl.DisplayNames(['en'], { type: 'language' });
const rows = locales
  .map(analyze)
  .map((r) => ({
    name: names.of(r.code === 'zh-CN' ? 'zh-Hans' : r.code),
    pct: Math.round((r.translated / todoKeys.length) * 100),
    left: todoKeys.length - r.translated,
  }))
  .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));

const body = rows.map((r, i) => {
  const y = i * ROW;
  return [
    `<text x="0" y="${y + 15}">${r.name}</text>`,
    `<rect class="track" x="${NAME_W}" y="${y + 6}" width="${BAR_W}" height="10" rx="5"/>`,
    `<rect class="fill" x="${NAME_W}" y="${y + 6}" width="${(BAR_W * r.pct) / 100}" height="10" rx="5"/>`,
    `<text x="${NAME_W + BAR_W + 12}" y="${y + 15}">${r.pct}%</text>`,
    `<text class="dim" x="${WIDTH}" y="${y + 15}" text-anchor="end">${r.left} left</text>`,
  ].join('');
});

writeFileSync(
  process.argv[2],
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${rows.length * ROW}" role="img" aria-label="Translation progress per language">` +
    '<style>text{font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#1f2328}.dim{fill:#656d76}.track{fill:#d0d7de}.fill{fill:#1cd667}' +
    '@media (prefers-color-scheme:dark){text{fill:#e6edf3}.dim{fill:#8b949e}.track{fill:#30363d}}</style>' +
    `${body.join('')}</svg>\n`,
);
