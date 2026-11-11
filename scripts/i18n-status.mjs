#!/usr/bin/env node
/**
 * Translation status report. English (`en.json`) is the source of truth; every
 * other locale in `src/i18n/locales/` is compared against it.
 *
 *   pnpm i18n:status              summary table for all locales
 *   pnpm i18n:status es           details for one locale (what's missing, etc.)
 *   pnpm i18n:status --todo es    just the untranslated keys, ready to paste
 *
 * "missing"   = key exists in English but not in the locale (falls back to English).
 * "same"      = present but identical to the English text (often still untranslated).
 * "stale"     = key in the locale that no longer exists in English (safe to delete).
 *
 * Every key listed comes with where it shows up in the app and, if it needed
 * saying, what it means: a key on its own is what sends somebody to Discord to
 * ask. See `scripts/i18n-lib.mjs` for where that comes from.
 *
 * Context overrides ("Base::context") are optional, so they never count as
 * missing. They were also invisible here, which meant the only way to learn one
 * existed was reading TRANSLATING.md and hoping it was up to date.
 */
import {
  analyze,
  baseKey,
  describe,
  en,
  enKeys,
  keepEnglish,
  meaning,
  locales,
  notes,
  callSites,
  todoKeys,
} from './i18n-lib.mjs';

const sites = callSites();
/** Every `t('Base::context')` used in the source, so the report can offer them. */
const contextKeys = [...sites.keys()]
  .filter((k) => k.includes('::') && baseKey(k) in en)
  .sort();

// Parse args: optional `--todo` flag and an optional locale code.
const args = process.argv.slice(2);
const todo = args.includes('--todo');
const gaps = args.includes('--gaps');
const one = args.find((a) => !a.startsWith('--'));

if (gaps) {
  // Which strings have nowhere to look but the words themselves. Not all of
  // them need a note: "Couldn't load the album." says what it is. This is for
  // reading down and spotting the ones that don't, before somebody has to ask.
  // Not `notes[k]`: a string the code explains by itself, because it is the
  // line under a setting or one of its values, is not a gap. Counting those was
  // asking for a note that would only repeat what the tools already say.
  const without = enKeys.filter((k) => !keepEnglish.has(k) && !meaning(k));
  console.log(`\n${without.length} of ${enKeys.length - keepEnglish.size} strings have nothing but the screen they are on.`);
  console.log('A note is worth writing when the English and the screen are not enough.\n');
  for (const k of without) console.log(`  ${JSON.stringify(k)}\n      ${describe(k, sites) || '?'}`);
  console.log('\nWrite them in src/i18n/context.jsonc, then: pnpm i18n:docs\n');
  process.exit(0);
}

if (one && !locales.includes(one)) {
  console.error(`Unknown locale "${one}". Available: ${locales.join(', ')}`);
  process.exit(1);
}

const pct = (n) => `${Math.round((n / todoKeys.length) * 100)}%`;

if (todo) {
  // Bare list of untranslated (missing + same) keys, one per line, to hand off.
  const { missing, same } = analyze(one ?? locales[0]);
  for (const k of [...missing, ...same]) console.log(k);
  process.exit(0);
}

if (one) {
  const r = analyze(one);
  console.log(`\n${one}: ${r.translated}/${todoKeys.length} translated (${pct(r.translated)})\n`);
  const section = (title, list, withContext = true) => {
    if (list.length === 0) return;
    console.log(`${title} (${list.length}):`);
    for (const k of list) {
      const about = withContext ? describe(k, sites) : '';
      console.log(about ? `  ${k}\n      ${about}` : `  ${k}`);
    }
    console.log('');
  };
  section('Missing', r.missing);
  section('Same as English', r.same);
  section('Stale (delete these)', r.stale, false);
  // Optional: only worth adding when the base word can't cover both uses in
  // this language, so these are listed as an offer, not as pending work.
  const contexts = contextKeys.filter((k) => !(k in r.dict));
  if (contexts.length) {
    console.log(`Context overrides you could add (${contexts.length}, all optional):`);
    for (const k of contexts) {
      console.log(`  ${k}   falls back to "${r.dict[baseKey(k)] ?? en[baseKey(k)]}"`);
      const about = describe(k, sites);
      if (about) console.log(`      ${about}`);
    }
    console.log('');
  }
  if (!r.missing.length && !r.same.length && !r.stale.length) console.log('All good ✓\n');
  console.log(`Start translating: pnpm i18n:scaffold ${one}\n`);
  process.exit(0);
}

// Summary table for every locale.
console.log(`\nSource: en.json, ${todoKeys.length} strings to translate`);
if (keepEnglish.size) {
  console.log(`(${keepEnglish.size} more are meant to stay in English; see src/i18n/context.jsonc)`);
}
// A note for a key that no longer exists is the drift this file is meant to
// stop, so it says so rather than waiting to be noticed.
//
// Judged by the base key, the way `i18n:check` judges it. An override
// ("Never::expiry") is a real string with a real note, and it is never in
// en.json by design: English needs one word where another language may need
// two. Asked the other way, this reported every one of them as gone, which is
// a warning that trains you to ignore warnings.
const orphaned = Object.keys(notes).filter((k) => !(baseKey(k) in en));
if (orphaned.length) {
  console.log(`\n⚠ context.jsonc describes ${orphaned.length} keys that are gone: ${orphaned.join(', ')}`);
}
// An English key nothing asks for is a string every translator has been
// translating for a screen that will never show it: five of them had survived a
// rewording each. Worth saying out loud, and worth checking before deleting,
// since a string built somewhere clever would look the same from here.
const unused = todoKeys.filter((k) => !sites.has(k));
if (unused.length) {
  console.log(`\n⚠ ${unused.length} English keys are not used anywhere in the app:`);
  for (const k of unused) console.log(`    ${JSON.stringify(k)}`);
  console.log('  Check, then delete them from en.json (and es/ca; the rest report as stale).');
}
console.log('');
const rows = locales.map((c) => analyze(c));
const w = Math.max(6, ...locales.map((c) => c.length));
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('locale', w)}  translated   missing   same   stale`);
console.log('-'.repeat(w + 38));
for (const r of rows) {
  console.log(
    `${pad(r.code, w)}  ${pad(`${r.translated} (${pct(r.translated)})`, 10)}  ${pad(r.missing.length, 7)}  ${pad(r.same.length, 5)}  ${r.stale.length}`,
  );
}
console.log(
  `\nDetails: pnpm i18n:status <locale>   ·   file to work in: pnpm i18n:scaffold <locale>\n`,
);
