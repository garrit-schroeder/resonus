#!/usr/bin/env node
/**
 * Adds a release to `Source.json`, with its notes from CHANGELOG.md.
 *
 *   node scripts/altstore-add-version.mjs <version> <date> <ipa size in bytes>
 *
 * Does nothing if the version is already there, so a rerun is safe. Fails rather
 * than publishing empty notes if the changelog has no section for it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [version, date, size] = process.argv.slice(2);
if (!version || !date || !Number(size)) {
  console.error('Usage: altstore-add-version.mjs <version> <date> <ipa size in bytes>');
  process.exit(1);
}

const source = JSON.parse(readFileSync('Source.json', 'utf8'));
const versions = source.apps[0].versions;
if (versions.some((v) => v.version === version)) {
  console.log(`${version} is already in Source.json`);
  process.exit(0);
}

const section = readFileSync('CHANGELOG.md', 'utf8')
  .split(/^## /m)
  .find((s) => s.startsWith(`[${version}]`));
if (!section) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

const notes = section
  .split('\n')
  .slice(1)
  .filter((line) => line.trim())
  .map((line) => line.replace(/^### /, '').replace(/^(\s*)- /, '$1'))
  .join('\n');

// First: AltStore takes the first entry as the latest version.
versions.unshift({
  version,
  date,
  size: Number(size),
  downloadURL: `https://github.com/juananzzz/resonus/releases/download/v${version}/resonus-v${version}.ipa`,
  localizedDescription: notes,
  minOSVersion: versions[0].minOSVersion,
});

writeFileSync('Source.json', `${JSON.stringify(source, null, 4)}\n`);
