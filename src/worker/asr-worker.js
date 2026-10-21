// Speech recognition worker, owned by the background page. Bundled with
// transformers.js into build/dist/asr-worker.js by tools/build.mjs.
//
// Everything it loads comes from inside the extension: remote models are
// disabled and onnxruntime's WASM runtime is pointed at the bundled copy
// (transformers.js would otherwise fetch it from a CDN). The extension CSP
// (connect-src 'self') blocks any other network access as a second layer.
//
// Messages in:  { type: 'load', model, kind: 'whisper' | 'ctc', slot? }
//               { type: 'transcribe', id, model, kind, slot?, audio: Float32Array (16 kHz mono), choices? }
//               (choices: how many answers will be offered, 1-5, default 3)
//               (slot is set for a custom model: 'en' or 'ja-kana')
// Messages out: { type: 'progress', model, loaded, total }
//               { type: 'loaded', model, ms }
//               { type: 'result', id, candidates: string[] (best first), ms }
//               | { type: 'result', id, noSpeech: true, ms }  (Silero heard no speech)
//               | { type: 'error', id?, model?, message }
//
// Both return a few candidates, best first, for the user to choose from:
// English models via alternative tokens at any step, the hiragana CTC model
// (Japanese readings) via greedy + beam search.
import { env, HubertForCTC, LogitsProcessor, pipeline, Tensor } from '@huggingface/transformers';
// The same onnxruntime entry transformers.js uses (mapped to the WASM-only
// build in tools/build.mjs), so the bundle has one runtime.
import * as ort from 'onnxruntime-web/wasm';
import { recognize, recognizeCtc } from './recognize.js';
import { createVad } from './vad.js';
// Custom models chosen in the settings live in IndexedDB (sets globalThis.WKV.modelStore).
import '../shared/model-store.js';

const EXT_ROOT = new URL('../', self.location.href).href; // build/ root

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${EXT_ROOT}models/`;
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${EXT_ROOT}vendor/ort/ort-wasm-simd-threaded.mjs`,
  wasm: `${EXT_ROOT}vendor/ort/ort-wasm-simd-threaded.wasm`,
};
// Extension pages aren't cross-origin isolated, so no SharedArrayBuffer threads.
env.backends.onnx.wasm.numThreads = 1;

// Custom models: their files are read from IndexedDB into memory and served
// to transformers.js through its cache hook, which it consults before
// loading any model file. Keys are the paths it would otherwise load,
// `${localModelPath}${model}/${file}`; everything else falls through to the
// bundled files.
const customFiles = new Map();
env.useCustomCache = true;
env.customCache = {
  async match(request) {
    const buffer = customFiles.get(typeof request === 'string' ? request : request?.url);
    return buffer ? new Response(buffer, { headers: { 'content-length': String(buffer.byteLength) } }) : undefined;
  },
  async put() {},
};

// Precision of the built-in models' ONNX files (as listed in
// models/models.json), as transformers.js names them; the rest are 8-bit.
// Moonshine's encoder is float16: the 8-bit one costs 5 of 300 first
// choices on real recordings (2026-10-18), for 20 MB more.
const BUILTIN_DTYPE = { 'moonshine-base': { encoder_model: 'fp16', decoder_model_merged: 'q8' } };

// Returns the custom model's precision.
async function loadCustomFiles(model, slot) {
  const record = await globalThis.WKV.modelStore.get(slot);
  if (!record || record.id !== model) throw new Error('custom model not found in storage');
  // Check the ONNX files with onnxruntime directly before transformers.js
  // sees them: it queues every session creation on one shared promise chain,
  // so a single broken model would make all later loads fail too, built-in
  // models included.
  for (const [path, buffer] of Object.entries(record.files)) {
    if (!path.endsWith('.onnx')) continue;
    try {
      const session = await ort.InferenceSession.create(new Uint8Array(buffer));
      await session.release();
    } catch (err) {
      throw new Error(`${path} isn't a usable ONNX model`);
    }
  }
  for (const [path, buffer] of Object.entries(record.files)) {
    customFiles.set(`${env.localModelPath}${model}/${path}`, buffer);
  }
  // Models installed before format 2 are 8-bit; one precision throughout is
  // passed as a plain name, as for the built-in models.
  const precisions = new Set(Object.values(record.dtype ?? { model: 'q8' }));
  return precisions.size === 1 ? [...precisions][0] : record.dtype;
}

const pipelines = new Map(); // model -> Promise<{ kind, asr, vocab? }>

// Silero VAD, loaded with the first model; ort shares transformers.js's env
// (bundled WASM, one thread).
let vadPromise = null;
function vad() {
  vadPromise ??= createVad(ort, `${EXT_ROOT}models/silero-vad/onnx/model.onnx`);
  return vadPromise;
}

async function loadModel(model, kind, slot, options) {
  options.dtype = slot ? await loadCustomFiles(model, slot) : BUILTIN_DTYPE[model] ?? 'q8';
  if (kind === 'ctc') {
    const asr = await HubertForCTC.from_pretrained(model, options);
    // The exported config carries the kana vocabulary (tools/export-dual-ctc.py).
    return { kind, asr, vocab: asr.config.kana_vocab };
  }
  return { kind, asr: await pipeline('automatic-speech-recognition', model, options) };
}

function load(model, kind, slot) {
  if (!pipelines.has(model)) {
    const t0 = performance.now();
    const files = new Map();
    const p = loadModel(model, kind, slot, {
      device: 'wasm',
      progress_callback: info => {
        if (info.status !== 'progress' || !info.total) return;
        files.set(info.file, info);
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'progress', model, loaded, total });
      },
    }).then(loaded => {
      self.postMessage({ type: 'loaded', model, ms: Math.round(performance.now() - t0) });
      return loaded;
    });
    p.catch(() => pipelines.delete(model));
    pipelines.set(model, p);
  }
  return pipelines.get(model);
}

// Whisper emits these for silence or noise rather than nothing.
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|♪/g;

// Surface failures that escape the handlers below (e.g. inside onnxruntime's
// loader); otherwise the background only sees an error event with no message.
self.addEventListener('unhandledrejection', e => {
  self.postMessage({ type: 'error', message: String(e.reason?.message ?? e.reason) });
});

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await Promise.all([
        load(data.model, data.kind, data.slot).catch(err => {
          self.postMessage({ type: 'error', model: data.model, message: String(err?.message ?? err) });
        }),
        vad(),
      ]);
    } else if (data.type === 'transcribe') {
      const { kind, asr, vocab } = await load(data.model, data.kind, data.slot);
      const t0 = performance.now();
      if (!(await (await vad()).hasSpeech(data.audio))) {
        self.postMessage({ type: 'result', id: data.id, noSpeech: true, ms: Math.round(performance.now() - t0) });
        return;
      }
      // More candidates only when more choices are shown: at 5 choices,
      // readings offered 284 -> 288 of 400 with a 5-deep beam, English
      // 272 -> 274 of 300 with 6 alternatives (2026-10-20); at 3 they gain
      // nothing and English decodes slower.
      const more = (data.choices ?? 3) > 3;
      const candidates = kind === 'ctc'
        ? await recognizeCtc(asr, vocab, data.audio, Tensor, more ? 5 : 3)
        : (await recognize(asr, data.audio, { alternatives: more ? 6 : 4, LogitsProcessorClass: LogitsProcessor }))
          .map(text => String(text).replace(NON_SPEECH, ' ').trim());
      self.postMessage({ type: 'result', id: data.id, candidates, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message ?? err) });
  }
};
