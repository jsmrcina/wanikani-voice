// Makes the WaniKani dictionary file for Settings → WaniKani dictionary:
// every radical, kanji and vocabulary meaning and reading your account can
// see, at every level, plus your own meaning synonyms. The extension never
// contacts WaniKani's API itself; you choose this file in the settings.
//
//   node tools/wk-dictionary.mjs [--out FILE] [--token-file FILE]
//
// The token comes from WANIKANI_API_TOKEN or ~/.config/wanikani-voice/api-token
// (a read-only token is enough). Requests stay within WaniKani's rate limit;
// a full download is about 15. The file holds WaniKani's content from your
// own account: for your own use, don't share it. Default output:
// dist/wanikani.wkv-dict.json (not tracked by git).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadDictionary, readToken } from './lib/wanikani-api.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = resolve(opt('--out') ?? join(ROOT, 'dist/wanikani.wkv-dict.json'));

const dictionary = await downloadDictionary(await readToken(opt('--token-file')), {
  log: console.warn, progress: n => console.log(`${n} subjects…`),
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(dictionary)}\n`);
console.log(`${out}: ${dictionary.subjects} subjects, ${dictionary.meanings.length} meanings, ${dictionary.readings.length} readings`);
