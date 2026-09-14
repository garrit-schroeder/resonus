#!/usr/bin/env node
/**
 * The checks a translation pull request should not need a person for.
 *
 *   pnpm i18n:check
 *
 * A translator finding out about a stray comma, or about a key that no longer
 * exists, three days later when somebody gets round to reviewing, is the part of
 * contributing that puts people off. All of it is knowable the moment they push.
 *
 * What it refuses:
 *   · a locale file that is not valid JSON
 *   · a key that is not in English, so nothing would ever look it up
 *   · a string the code asks for that en.json has not got
 *   · a translation that lost a `{placeholder}` the English has
 *   · a note in context.jsonc for a key that no longer exists
 *   · an English key nothing in the app asks for
 *   · docs/TRANSLATION-CONTEXT.md not matching what generates it
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LOCALES_DIR, ROOT, baseKey, callSites, en, enKeys, keepEnglish, loadLocale, locales, notes } from './i18n-lib.mjs';

const problems = [];
const fail = (msg) => problems.push(msg);

// Every locale reads, and holds only keys English has.
for (const code of locales) {
  let dict;
  try {
    dict = loadLocale(code);
  } catch (e) {
    fail(`${code}.json is not valid JSON: ${e.message}`);
    continue;
  }
  for (const [key, value] of Object.entries(dict)) {
    if (!(baseKey(key) in en)) continue; // reported as "stale", not an error
    if (typeof value !== 'string') {
      fail(`${code}.json: ${JSON.stringify(key)} is not a string`);
      continue;
    }
    // A placeholder dropped in translation is a name or a number that never
    // reaches the screen, and it is invisible until somebody hits that string.
    const holders = (s) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    const source = en[baseKey(key)];
    if (holders(source) !== holders(value)) {
      fail(
        `${code}.json: ${JSON.stringify(key)} should keep ${holders(source) || 'no placeholders'}, has ${holders(value) || 'none'}`,
      );
    }
  }
}

// The notes, and the strings they are about, still exist.
for (const key of Object.keys(notes)) {
  // An override ("Never::expiry") is a real string to explain, and a language
  // that needs it needs the note most, so it is judged by its base key.
  if (!(baseKey(key) in en)) fail(`context.jsonc describes "${key}", which is not in en.json`);
}
for (const key of keepEnglish) {
  if (!(key in en)) fail(`context.jsonc keeps "${key}" in English, but it is not in en.json`);
}

// An English key nothing asks for is a string every translator translates for a
// screen that will never show it.
const sites = callSites();
for (const key of enKeys) {
  if (!sites.has(key)) fail(`en.json has "${key}", which nothing in the app uses`);
}

// And the other way round: a string the code asks for that en.json does not
// hold is never offered to a translator, so every other language shows it in
// English and nobody finds out. From HeLLsSs, in #205.
for (const key of sites.keys()) {
  if (!(baseKey(key) in en)) fail(`the app uses "${key}", which is not in en.json`);
}

// And the page somebody reads on GitHub says what the code says.
try {
  execFileSync('node', [join(ROOT, 'scripts/i18n-docs.mjs'), '--check'], { stdio: 'pipe' });
} catch {
  fail('docs/TRANSLATION-CONTEXT.md is out of date. Run: pnpm i18n:docs');
}

// Nothing left behind by a locale that was deleted.
const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
if (!files.includes('en.json')) fail('en.json is missing');

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error('');
  process.exit(1);
}
console.log('\nTranslations check out ✓\n');
