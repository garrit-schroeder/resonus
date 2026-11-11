/**
 * What the translation tools all need: the English source, each locale, the
 * notes, and the part that is worked out rather than written down: where in
 * the app each string shows up.
 *
 * Somebody translating a JSON file is looking at "Direction": "" with nothing
 * around it, and the question they ask is always the same one: where is this,
 * what is it. Half of that answer is already in the code. Every string reaches
 * the screen through a `t('…')` call in a file, and in this app a file under
 * `src/app/` IS a screen, so the path is the answer: `src/app/settings/player`
 * is Settings › Player. Deriving it costs nothing and cannot fall behind, which
 * a table kept by hand in a document had been doing for three releases.
 *
 * The other half, what a word means when it is ambiguous on its own, cannot be
 * derived and lives in `src/i18n/context.jsonc`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCALES_DIR = join(ROOT, 'src/i18n/locales');
const SRC = join(ROOT, 'src');

/** JSON with `//` comments in it, which is the only way a data file can explain itself. */
export function parseJsonc(text) {
  // Only whole-line comments are stripped, so a `//` inside a string is safe:
  // "Website (optional)" and its friends would not survive anything cleverer.
  return JSON.parse(
    text
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n'),
  );
}

export const readJson = (path) => parseJsonc(readFileSync(path, 'utf8'));

export const loadLocale = (code) => readJson(join(LOCALES_DIR, `${code}.json`));

export const en = loadLocale('en');
export const enKeys = Object.keys(en);

export const locales = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'en.json')
  .map((f) => f.replace('.json', ''))
  .sort();

const context = readJson(join(ROOT, 'src/i18n/context.jsonc'));
/** Key → one line saying what it means, for the ones that are ambiguous alone. */
export const notes = context.notes;
/** Keys that are meant to stay in English (see the file). Not counted as missing. */
export const keepEnglish = new Set(context.keepEnglish);

/**
 * A key may carry an optional "::context" suffix (e.g. "About::artist"), an
 * override a language adds when the base term ("About") cannot cover every use.
 * Only the base key lives in English.
 */
export const baseKey = (k) => {
  const i = k.indexOf('::');
  return i === -1 ? k : k.slice(0, i);
};

/** Every `.ts`/`.tsx` file under `src/`. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * Key → the files that ask for it. Read off the `t('…')` and `tg('…')` calls,
 * which is what actually puts a string on a screen.
 *
 * A handful of strings are not written at a call site but sit in a list of
 * options somewhere (the sort orders, the server types on the login screen).
 * Those are found by a second pass over plain string literals, which is looser
 * and so is only trusted for keys the first pass did not place.
 */
export function callSites() {
  const sites = new Map();
  const add = (key, file) => {
    if (!sites.has(key)) sites.set(key, new Set());
    sites.get(key).add(relative(ROOT, file));
  };
  const files = sourceFiles().map((f) => [f, readFileSync(f, 'utf8')]);
  const CALL = /\b(?:t|tg)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const [file, src] of files) {
    for (const m of src.matchAll(CALL)) add(unescapeLiteral(m[2]), file);
  }
  const placed = new Set(sites.keys());
  const LITERAL = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const [file, src] of files) {
    // Comments first, and not out of tidiness: this pass pairs quotes as it
    // walks the file, so one apostrophe in a sentence of prose ("it's the
    // header") pairs with the next quote in the code and every literal after it
    // in that file is read wrong. That is what hid `Recents`, which is written
    // in a table of sort labels twenty lines under such a comment.
    for (const m of withoutComments(src).matchAll(LITERAL)) {
      const key = unescapeLiteral(m[2]);
      // By the base key too, since an override is never in en.json: English
      // needs one word where another language may need two. A sort label is
      // handed over as data (`{ frequent: 'Most played::songs' }`) and only
      // reaches `t()` inside the hook, so this pass is the only one that can
      // see it — and without this it saw nothing, which is how two of those
      // sat in the code for months without being offered to a translator.
      if ((key in en || baseKey(key) in en) && !placed.has(key)) add(key, file);
    }
  }
  // A base key whose every use asks for a context ("About" is only ever called
  // as `About::artist` or `About::app`) shows up wherever its overrides do.
  for (const [key, files] of [...sites]) {
    const base = baseKey(key);
    if (base === key || sites.has(base)) continue;
    for (const file of files) add(base, join(ROOT, file));
  }
  return sites;
}

const unescapeLiteral = (s) => s.replace(/\\(['"\\])/g, '$1');

/**
 * Drops the lines that are only a comment. Not a parser and not trying to be:
 * this codebase keeps its prose in whole-line comments and JSDoc blocks, which
 * is where the stray apostrophes are, and a `//` sitting after code is left
 * alone precisely because telling it from one inside a string needs the parser
 * we are not writing.
 */
const withoutComments = (src) =>
  src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');

/**
 * Which file imports which, so that a string living in a component can still be
 * told where it is seen.
 *
 * Half this app's text is in sheets and cards rather than in the screen file:
 * `SongMenuSheet` is not a place anybody has been to, and "Add anyway" showing
 * up as `PlaylistPickerSheet (components)` is barely more use to a translator
 * than nothing. But the screens that open it are places, and they are one hop
 * away up the imports.
 */
function importGraph() {
  const importers = new Map(); // file → the files that import it
  const resolve = (from, spec) => {
    const base = spec.startsWith('@/')
      ? join(SRC, spec.slice(2))
      : spec.startsWith('.')
        ? join(dirname(from), spec)
        : null;
    if (!base) return null; // a package, not ours
    for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const target = resolve(file, m[1]);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return importers;
}

let importersCache = null;

/**
 * The screens a file is seen from: itself if it is one, otherwise whoever
 * imports it, and whoever imports them. Stops at the first screens it finds, so
 * a component used by one screen names that screen rather than the whole app.
 */
function screensUsing(file) {
  const full = join(ROOT, file);
  if (file.startsWith(`src${sep}app${sep}`) || file.startsWith('src/app/')) return [screenName(file)];
  importersCache ??= importGraph();
  const seen = new Set([full]);
  let frontier = [full];
  for (let hop = 0; hop < 4 && frontier.length; hop += 1) {
    const next = [];
    const screens = new Set();
    for (const node of frontier) {
      for (const parent of importersCache.get(node) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        const rel = relative(ROOT, parent);
        if (rel.split(sep)[1] === 'app') screens.add(screenName(rel));
        else next.push(parent);
      }
    }
    if (screens.size) return [...screens].sort();
    frontier = next;
  }
  return [];
}

/**
 * The two strings a settings screen is made of, and which belongs to which.
 *
 * A settings row is a label and a line under it explaining it, and a select is
 * a label and its values. Read on their own, out of a JSON file, the second
 * half of each of those is the hardest kind of string there is: "Only if it is
 * the original file" is a sentence with nothing to hang it on until you know it
 * is one of four answers to "Play downloaded songs from the phone".
 *
 * Which is written down right there in the code, a few lines apart, so it is
 * read from there instead of being typed into the notes a hundred times and
 * going stale the first time a setting is reworded.
 */
function relations() {
  const out = new Map(); // key → { kind: 'description' | 'value', of: label }
  const LABEL = /\blabel(?:=\{|:\s*)t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/;
  const DESC = /\bdescription(?:=\{|:\s*)(?:t\(\s*)?(['"])((?:\\.|(?!\1)[^\\])*)\1/;
  const OPTION = /\bvalue:\s*[^,]+,\s*label:\s*t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/;
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let label = null;
    let since = 0;
    lines.forEach((line, i) => {
      const isOption = OPTION.test(line);
      const l = !isOption && LABEL.exec(line);
      if (l) {
        label = unescapeLiteral(l[2]);
        since = i;
        return;
      }
      if (!label || i - since > 12) return;
      // A description can sit on the line after its `description=` opener.
      const d = DESC.exec(line) ?? (/\bdescription(?:=\{|:\s*)t\($/.test(line.trim()) ? DESC.exec(lines[i + 1] ?? '') : null);
      if (d) {
        const key = unescapeLiteral(d[2]);
        if (key !== label && !out.has(key)) out.set(key, { kind: 'description', of: label });
        return;
      }
      const o = OPTION.exec(line);
      if (o) {
        const key = unescapeLiteral(o[2]);
        if (key !== label && !out.has(key)) out.set(key, { kind: 'value', of: label });
      }
    });
  }
  return out;
}

let relationsCache = null;

/** Path → what a person would call that place in the app. */
export function screenName(file) {
  const parts = file.split(sep);
  const name = parts[parts.length - 1].replace(/\.tsx?$/, '');
  if (parts[1] !== 'app') {
    // Not a screen: a component, a store, the player engine. Its own name is
    // the most useful thing we can say, and it is better than nothing.
    return `${name} (${parts[1]})`;
  }
  const route = parts.slice(2, -1).filter((p) => !/^\(.*\)$/.test(p));
  const words = (s) =>
    s
      .replace(/\[.*?\]/g, '')
      .replace(/[-_]/g, ' ')
      .trim();
  // A layout is not a screen but the frame around several, so whatever it draws
  // is drawn on all of them. The mini player and the battery warning live here,
  // and "anywhere in the app" is the honest answer for both.
  if (name.startsWith('_layout')) {
    return route.length ? `Any ${route.map(words).join(' › ')} screen` : 'Anywhere in the app';
  }
  const tail = name === 'index' ? '' : words(name);
  const crumbs = [...route.map(words), tail].filter(Boolean);
  if (crumbs.length === 0) return 'Home';
  const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return crumbs.map(title).join(' › ');
}

/** One line saying where a string shows up, or nothing if we cannot tell. */
export function whereShown(key, sites) {
  const files = sites.get(key);
  if (!files) return '';
  const names = new Set();
  const parts = new Set();
  for (const file of files) {
    const screens = screensUsing(file);
    for (const s of screens) names.add(s);
    // The component's own name goes in brackets: it is what somebody grepping
    // the code would look for, and for a sheet it is often the clearer half.
    if (!screens.includes(screenName(file))) parts.add(screenName(file).replace(/ \(.*\)$/, ''));
  }
  const where = [...names].sort();
  const shown =
    where.length > 3 ? `${where.slice(0, 3).join(', ')} and ${where.length - 3} more` : where.join(', ');
  const from = [...parts].sort().join(', ');
  if (shown && from) return `${shown} · in ${from}`;
  return shown || (from && `in ${from}`) || '';
}

/**
 * What this string is, in words: the note written for it, or what the code says
 * about it when nobody wrote one. Everything that shows context goes through
 * here, so the page on GitHub and the file in your editor say the same thing.
 * They did not, once, and the half that was missing was the half most people
 * read.
 */
export function meaning(key) {
  // An override ("Never::expiry") falls back to the base word's note, the same
  // way the app falls back to the base string.
  const written = notes[key] ?? notes[baseKey(key)];
  if (written) return written;
  // Nobody wrote one, but a settings row is a label and an explanation a few
  // lines apart, and a select is a label and its values. That is context too.
  relationsCache ??= relations();
  const rel = relationsCache.get(key);
  if (!rel) return '';
  return rel.kind === 'description'
    ? `The line under “${rel.of}”, explaining it`
    : `One of the values of “${rel.of}”`;
}

/** Where it shows up, plus what it means if that needed saying. */
export function describe(key, sites) {
  const where = whereShown(key, sites);
  const note = meaning(key);
  if (where && note) return `${where} · ${note}`;
  return note || where;
}

/** Strings that are meant to stay in English are nobody's work. */
export const todoKeys = enKeys.filter((k) => !keepEnglish.has(k));

export function analyze(code) {
  const dict = loadLocale(code);
  const keys = new Set(Object.keys(dict));
  const missing = todoKeys.filter((k) => !keys.has(k));
  const same = todoKeys.filter((k) => keys.has(k) && dict[k] === en[k]);
  const stale = Object.keys(dict).filter((k) => !(baseKey(k) in en));
  const translated = todoKeys.length - missing.length - same.length;
  return { code, dict, missing, same, stale, translated };
}
