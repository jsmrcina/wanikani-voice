// Builds a personal recording list of English meanings from your unlocked
// WaniKani radicals, kanji and vocabulary, for testing English recognition
// on your voice and for fine-tuning an English model (PLAN.md §8).
//
// Dev-time only. The extension itself never calls the WaniKani API.
//
//   node tools/wk-meanings.mjs [--max 300] [--seed 1] [--test-share 0.2]
//
// The mix leans on what the models get wrong: short single words (moon ->
// "no", eye -> "I") and multi-word answers (Moonshine repeats them), plus
// ordinary meanings. A share of each group is marked "split": "test" and is
// kept out of fine-tuning, for accuracy tests (tools/eval-asr.mjs).
//
// Needs a read-only WaniKani API token in ~/.config/wanikani-voice/api-token.
// Adds the "en" list to personal/words.json (the private submodule), keeping
// the Japanese one, for:
//   python3 tools/recorder/server.py --words personal/words.json --set personal
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.wanikani.com/v2';
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MAX = opt('max', 300);
const TEST_SHARE = opt('test-share', 0.2);
const SHARES = { short: 0.35, phrase: 0.25, other: 0.4 };

// The extension's own normaliser gives the expected text ("Twenty-One" -> "21").
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(await readFile(join(ROOT, 'src/shared/normalize.js'), 'utf8'), sandbox);
const { normalizeAnswer } = sandbox.WKV.normalize;

// Small seeded PRNG (mulberry32), so a list can be regenerated exactly.
let seed = opt('seed', 1) >>> 0;
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function sample(list, n) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const token = (await readFile(join(homedir(), '.config/wanikani-voice/api-token'), 'utf8')).trim();
async function* paged(url) {
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Wanikani-Revision': '20170710' } });
    if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
    const page = await res.json();
    yield* page.data;
    url = page.pages.next_url;
  }
}

const ids = [];
for await (const a of paged(`${API}/assignments?unlocked=true`)) ids.push(a.data.subject_id);
console.log(`${ids.length} unlocked radicals/kanji/vocabulary`);

const meanings = new Map(); // expected text -> entry
for (let i = 0; i < ids.length; i += 500) {
  for await (const s of paged(`${API}/subjects?ids=${ids.slice(i, i + 500).join(',')}`)) {
    const primary = s.data.meanings.find(m => m.primary && m.accepted_answer);
    if (!primary) continue;
    const norm = normalizeAnswer(primary.meaning, 'en');
    if (!norm.ok || meanings.has(norm.text)) continue;
    const words = norm.text.split(' ').length;
    const group = words > 1 ? 'phrase' : norm.text.length <= 4 ? 'short' : 'other';
    meanings.set(norm.text, {
      slug: `wk${s.id}`, say: primary.meaning, hint: `${s.object}: ${s.data.characters ?? '(image radical)'}`,
      expected: norm.text, group,
    });
  }
}
const all = [...meanings.values()];
const chosen = [];
for (const [group, share] of Object.entries(SHARES)) {
  const pool = all.filter(w => w.group === group);
  const picked = sample(pool, Math.min(pool.length, Math.round(MAX * share)));
  const nTest = Math.round(picked.length * TEST_SHARE);
  picked.forEach((w, i) => chosen.push({ ...w, split: i < nTest ? 'test' : 'train' }));
  console.log(`${group.padEnd(6)} ${pool.length} available, keeping ${picked.length} (${nTest} held out for testing)`);
}
chosen.sort((a, b) => a.slug.localeCompare(b.slug, 'en', { numeric: true }));

const out = join(ROOT, 'personal/words.json');
const list = JSON.parse(await readFile(out, 'utf8').catch(() => '{"en":[],"ja":[],"noise":[]}'));
list.comment = 'Personal lists from your unlocked WaniKani items: readings (tools/wk-readings.py) and meanings (tools/wk-meanings.mjs).';
list.en = chosen;
list.ja ??= [];
list.noise ??= [];
await writeFile(out, `${JSON.stringify(list, null, 1)}\n`);
console.log(`wrote ${chosen.length} English meanings to personal/words.json`);
