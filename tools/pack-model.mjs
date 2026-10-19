// Packs an exported speech model into a .wkv-model.zip that can be chosen in
// the extension's settings (Custom models), e.g. a model fine-tuned on your
// voice with tools/finetune-hiragana.py + tools/export-dual-ctc.py, or
// tools/finetune-moonshine.py + tools/export-moonshine.py.
//
//   node tools/pack-model.mjs MODEL_DIR --language en|ja-kana [--name NAME] [--out FILE]
//                             [--encoder q8|fp16|fp32] [--decoder q8|fp16|fp32]
//
// MODEL_DIR is a folder in the layout transformers.js loads (config.json,
// onnx/..., and for Whisper / Moonshine the tokenizer files). The kind
// (Whisper, Moonshine or the hiragana CTC model) is detected from config.json, and the file is checked
// the same way the extension will check it.
//
// --encoder / --decoder: the precision of a Whisper or Moonshine model's
// encoder and decoder (default: the 8-bit files, *_quantized.onnx). A
// Moonshine encoder in float16 is what the extension ships; full precision
// (fp32 for both) is a little more accurate again, at four times the size.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { zip } from './lib/zip.mjs';

// The extension's own checks (classic script; attaches WKV.modelStore).
globalThis.WKV = {};
await import('../src/shared/model-store.js');
const { requiredFiles, SUFFIX } = globalThis.WKV.modelStore;
const SLOT_KINDS = { en: ['whisper', 'moonshine'], 'ja-kana': ['ctc'] };

const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const language = opt('--language');
if (!dir || !SLOT_KINDS[language]) {
  console.error('usage: node tools/pack-model.mjs MODEL_DIR --language en|ja-kana [--name NAME] [--out FILE]');
  process.exit(2);
}
const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
const kind = config.kana_vocab ? 'ctc' : ['whisper', 'moonshine'].includes(config.model_type) ? config.model_type : null;
if (!SLOT_KINDS[language].includes(kind)) {
  console.error(`${dir} looks like a ${kind ?? 'unknown'} model; ${language} needs a ${SLOT_KINDS[language].join(' or ')} model`);
  process.exit(1);
}
const name = opt('--name') ?? basename(resolve(dir));
const dtype = {};
for (const [flag, part] of [['--encoder', 'encoder_model'], ['--decoder', 'decoder_model_merged']]) {
  const d = opt(flag);
  if (d === undefined || d === 'q8') continue;
  if (kind === 'ctc' || !(d in SUFFIX)) {
    console.error(`${flag} ${d}: ${kind === 'ctc' ? 'only for Whisper and Moonshine models' : `one of ${Object.keys(SUFFIX).join(', ')}`}`);
    process.exit(2);
  }
  dtype[part] = d;
}
// Format 1 (8-bit throughout) still installs in versions before 0.3.2.
const meta = Object.keys(dtype).length ? { format: 2, language, kind, name, dtype } : { format: 1, language, kind, name };
const entries = [{ name: 'wkv-model.json', data: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`) }];
for (const file of requiredFiles(kind, dtype)) {
  entries.push({ name: file, data: await readFile(join(dir, file)), store: file.endsWith('.onnx') });
}
const out = resolve(opt('--out') ?? join('dist/models', `${name}.wkv-model.zip`));
await mkdir(dirname(out), { recursive: true });
const archive = zip(entries);
await writeFile(out, archive);
console.log(`${out}  ${(archive.length / 1024 / 1024).toFixed(1)} MB  (${kind} model for ${language}, "${name}")`);
