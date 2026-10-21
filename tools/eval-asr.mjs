// Offline accuracy check for the bundled speech models (spike S5).
//
//   node tools/eval-asr.mjs [model ...] [--real | --set NAME | --personal [SPLIT]] [--only a,b] [--ja] [--show-misses]
//                           [--opts JSON] [--choices JSON] [--dump FILE] [--dtype D] [--dictionary FILE]
//
// Runs each model over the English fixtures with the same normalisation the
// extension uses, and reports exact-match accuracy and decode time.
// Default set: synthetic TTS clips (test/fixtures/audio/en); --real: the
// recordings made with tools/recorder (personal/fixtures/<set>, in the private
// submodule), including
// the noise checks, which pass only if they produce no answer. --personal:
// the personal English list (personal/words.json, tools/wk-meanings.mjs)
// recorded into personal/recordings/en, by default only its held-out
// "test" split (--personal all for every recorded clip); with --ja, the
// 400 recorded readings (personal/recordings/ja). Uses
// transformers.js on Node (native onnxruntime), so absolute speed differs from
// Firefox's WASM backend; accuracy should match.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { env, HubertForCTC, LogitsProcessor, pipeline, Tensor } from '@huggingface/transformers';
import { recognize, recognizeCtc, recognizeKana } from '../src/worker/recognize.js';
import { createVad } from '../src/worker/vad.js';
import * as ortNode from 'onnxruntime-node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const showMisses = args.includes('--show-misses');
const setIdx = args.indexOf('--set');
const real = args.includes('--real') || setIdx >= 0;
const lang = args.includes('--ja') ? 'ja' : 'en';
// --models-root DIR: evaluate models from elsewhere (e.g. personal fine-tuned exports).
const rootIdx = args.indexOf('--models-root');
const setName = setIdx >= 0 ? args[setIdx + 1] : 'real';
const models = args.filter((a, i) => !a.startsWith('--') && !['--set', '--models-root', '--personal', '--only', '--opts', '--choices', '--dump', '--dtype', '--dictionary'].includes(args[i - 1]));
// --opts JSON: extra options for recognize() (English decoding experiments).
const optsIdx = args.indexOf('--opts');
const recognizeOpts = optsIdx >= 0 ? JSON.parse(args[optsIdx + 1]) : {};
// --choices JSON: extra options for buildChoices() (e.g. {"homophones":false}).
const choicesIdx = args.indexOf('--choices');
const choiceOpts = choicesIdx >= 0 ? JSON.parse(args[choicesIdx + 1]) : {};
// As in the extension (src/worker/asr-worker.js), more than 3 choices also
// draws on more candidates.
const moreCandidates = (choiceOpts.max ?? 3) > 3;
// --dictionary FILE: rank by a WaniKani dictionary (tools/wk-dictionary.mjs),
// normalised as the background page does.
const dictIdx = args.indexOf('--dictionary');
const dictionaryFile = dictIdx >= 0 ? JSON.parse(await readFile(args[dictIdx + 1], 'utf8')) : null;
// --dtype D: model precision, as transformers.js names it (q8, fp32, fp16,
// q4, q4f16, bnb4, int8), or JSON per file, e.g.
// {"encoder_model":"fp32","decoder_model_merged":"q8"}. Default: the
// model's "dtype" in models/models.json (what the extension loads), or q8.
const dtypeIdx = args.indexOf('--dtype');
const dtypeArg = dtypeIdx < 0 ? null : args[dtypeIdx + 1].startsWith('{') ? JSON.parse(args[dtypeIdx + 1]) : args[dtypeIdx + 1];
const { models: manifest } = JSON.parse(await readFile(join(ROOT, 'models/models.json'), 'utf8'));
// --dump FILE: every clip's choices as JSON (one file per model: FILE.<model>.json).
const dumpIdx = args.indexOf('--dump');

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = (args.includes('--models-root') ? resolve(args[args.indexOf('--models-root') + 1]) : join(ROOT, 'models')) + '/';

// Load the extension's normaliser (a classic script) into this process.
const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['src/shared/homophones.js', 'src/shared/normalize.js']) {
  vm.runInContext(await readFile(join(ROOT, file), 'utf8'), sandbox);
}
const { normalizeAnswer, buildChoices } = sandbox.WKV.normalize;

export function decodeWav(buf) {
  // Minimal PCM16 mono WAV reader (what tools/make-test-audio.py writes).
  let off = 12;
  let fmt = null;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== 16000) throw new Error('expected 16 kHz mono PCM16');
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

let fixtures;
let fixtureDir;
const personalIdx = args.indexOf('--personal');
if (personalIdx >= 0) {
  const split = args[personalIdx + 1] && !args[personalIdx + 1].startsWith('--') ? args[personalIdx + 1] : 'test';
  const words = JSON.parse(await readFile(join(ROOT, 'personal/words.json'), 'utf8'));
  fixtureDir = join(ROOT, 'personal/recordings');
  const recorded = new Set((await readdir(join(fixtureDir, lang)).catch(() => [])).map(f => f.replace(/\.wav$/, '')));
  // The readings have no split: the generic model never trained on any of them.
  fixtures = words[lang].filter(w => (split === 'all' || lang === 'ja' || w.split === split) && recorded.has(w.slug))
    .map(w => ({ file: `${lang}/${w.slug}.wav`, said: w.say, expected: w.expected, group: w.group, split: w.split }));
  console.log(`personal ${lang === 'ja' ? 'readings' : `English, ${split} split`}: ${fixtures.length} recorded clips`);
} else if (real) {
  const words = JSON.parse(await readFile(join(ROOT, 'tools/recorder/words.json'), 'utf8'));
  fixtureDir = join(ROOT, 'personal/fixtures', setName);
  fixtures = [...words[lang].map(w => ({ ...w, lang })), ...words.noise.map(w => ({ ...w, lang: 'noise' }))]
    .map(w => ({ file: `${w.lang}/${w.slug}.wav`, said: w.say, expected: w.expected }));
  // Older sets lack some later recordings.
  const present = new Set((await Promise.all(['en', 'ja', 'noise'].map(d => readdir(join(fixtureDir, d)).then(fs => fs.map(f => `${d}/${f}`), () => [])))).flat());
  fixtures = fixtures.filter(f => present.has(f.file));
} else {
  fixtureDir = join(ROOT, 'test/fixtures/audio/en');
  fixtures = JSON.parse(await readFile(join(fixtureDir, 'manifest.json'), 'utf8'));
}
// --only a,b,c: just those clips (file names without .wav).
const onlyIdx = args.indexOf('--only');
if (onlyIdx >= 0) {
  const only = new Set(args[onlyIdx + 1].split(','));
  fixtures = fixtures.filter(f => only.has(f.file.replace(/^.*\//, '').replace(/\.wav$/, '')));
}
const vad = await createVad(ortNode, join(ROOT, 'models/silero-vad/onnx/model.onnx'));
const candidates = models.length ? models : lang === 'ja' ? ['distilhubert-hiragana'] : ['whisper-base.en'];

for (const name of candidates) {
  const dtype = dtypeArg ?? manifest[name]?.dtype ?? 'q8';
  // Japanese: the hiragana CTC model, or multilingual Whisper limited to hiragana.
  const ctc = name.includes('hiragana');
  const asr = ctc
    ? await HubertForCTC.from_pretrained(name, { dtype, device: 'cpu' })
    : await pipeline('automatic-speech-recognition', name, { dtype, device: 'cpu' });
  const tokenizerJson = lang === 'ja' && !ctc
    ? JSON.parse(await readFile(join(ROOT, 'models', name, 'tokenizer.json'), 'utf8')) : null;
  const vocab = ctc ? asr.config.kana_vocab : null;
  const mode = lang === 'ja' ? 'ja-kana' : 'en';
  const dictionary = dictionaryFile && new Set((mode === 'en' ? dictionaryFile.meanings : dictionaryFile.readings)
    .map(a => normalizeAnswer(a, mode)).filter(n => n.ok).map(n => n.text));
  let inTop = 0;
  let hits = 0;
  let totalMs = 0;
  let maxMs = 0;
  const misses = [];
  const groups = {}; // group -> { n, first, offered } (personal lists)
  const ranks = [0, 0, 0, 0]; // expected answer was choice 1, 2, 3, or not offered
  const dump = [];
  for (const f of fixtures) {
    const audio = decodeWav(await readFile(join(fixtureDir, f.file)));
    // Like the extension: clips Silero VAD finds no speech in never reach the model.
    if (!(await vad.hasSpeech(audio))) {
      if (f.expected === null) hits += 1;
      else {
        misses.push(`${f.file}: said "${f.said}" -> no speech detected`);
        ranks[3] += 1;
        if (f.group) (groups[f.group] ??= { n: 0, first: 0, offered: 0 }).n += 1;
      }
      continue;
    }
    const t0 = performance.now();
    // Same candidate handling as the background page: normalise, drop
    // invalid ones, de-duplicate, keep three.
    let candidates;
    if (ctc) candidates = await recognizeCtc(asr, vocab, audio, Tensor, moreCandidates ? 5 : 3);
    else if (lang === 'ja') candidates = [await recognizeKana(asr, audio, tokenizerJson, LogitsProcessor)];
    else candidates = await recognize(asr, audio, { alternatives: moreCandidates ? 6 : 4, LogitsProcessorClass: LogitsProcessor, budgetMs: null, ...recognizeOpts });
    const built = buildChoices(candidates, mode, { ...choiceOpts, dictionary });
    const choices = built.ok ? built.choices : [];
    dump.push({ file: f.file, expected: f.expected, split: f.split, choices });
    if (f.expected && choices.includes(f.expected)) inTop += 1;
    if (f.expected) {
      const r = choices.indexOf(f.expected);
      ranks[r < 0 ? 3 : r] += 1;
    }
    const out = { text: candidates[0] ?? '' };
    const ms = performance.now() - t0;
    totalMs += ms;
    maxMs = Math.max(maxMs, ms);
    const norm = choices.length ? { ok: true, text: choices[0] } : normalizeAnswer(out.text, mode);
    const pass = f.expected === null ? !norm.ok : norm.ok && norm.text === f.expected;
    if (pass) hits += 1;
    else misses.push(`${f.file}: said "${f.said}" -> raw "${out.text.trim()}" -> ${norm.ok ? `"${norm.text}"` : norm.reason}` +
      (choices.length > 1 ? `  [choices: ${choices.join(' / ')}]` : ''));
    if (f.group) {
      const g = (groups[f.group] ??= { n: 0, first: 0, offered: 0 });
      g.n += 1;
      g.first += pass;
      g.offered += choices.includes(f.expected);
    }
  }
  console.log(`${name.padEnd(18)} ${hits}/${fixtures.length} exact (${(100 * hits / fixtures.length).toFixed(1)}%), ` +
    `mean ${(totalMs / fixtures.length).toFixed(0)} ms, max ${maxMs.toFixed(0)} ms`);
  console.log(`${''.padEnd(18)} expected answer among the offered choices: ${inTop}/${fixtures.filter(f => f.expected).length}`);
  console.log(`${''.padEnd(18)} by choice: 1st ${ranks[0]}, 2nd ${ranks[1]}, 3rd ${ranks[2]}, not offered ${ranks[3]}`);
  for (const [name, g] of Object.entries(groups)) {
    console.log(`${''.padEnd(18)} ${name.padEnd(6)} first ${g.first}/${g.n}, offered ${g.offered}/${g.n}`);
  }
  if (showMisses) misses.forEach(m => console.log(`   miss ${m}`));
  if (dumpIdx >= 0) await writeFile(`${args[dumpIdx + 1]}.${name}.json`, JSON.stringify(dump));
  await asr.dispose?.();
}
