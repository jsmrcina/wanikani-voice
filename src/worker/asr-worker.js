// Speech recognition worker, owned by the background page. Bundled with
// transformers.js into build/dist/asr-worker.js by tools/build.mjs.
//
// Everything it loads comes from inside the extension: remote models are
// disabled and onnxruntime's WASM runtime is pointed at the bundled copy
// (transformers.js would otherwise fetch it from a CDN). The extension CSP
// (connect-src 'self') blocks any other network access as a second layer.
//
// Messages in:  { type: 'load', model }
//               { type: 'transcribe', id, model, audio: Float32Array (16 kHz mono) }
// Messages out: { type: 'progress', model, loaded, total }
//               { type: 'loaded', model, ms }
//               { type: 'result', id, text, ms } | { type: 'error', id?, message }
import { env, pipeline } from '@huggingface/transformers';
import { recognize } from './recognize.js';

const EXT_ROOT = new URL('../', self.location.href).href; // build/ root

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${EXT_ROOT}models/`;
env.useBrowserCache = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${EXT_ROOT}vendor/ort/ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${EXT_ROOT}vendor/ort/ort-wasm-simd-threaded.asyncify.wasm`,
};
// Extension pages aren't cross-origin isolated, so no SharedArrayBuffer threads.
env.backends.onnx.wasm.numThreads = 1;

const pipelines = new Map(); // model -> Promise<pipeline>

function load(model) {
  if (!pipelines.has(model)) {
    const t0 = performance.now();
    const files = new Map();
    const p = pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: info => {
        if (info.status !== 'progress' || !info.total) return;
        files.set(info.file, info);
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: 'progress', model, loaded, total });
      },
    }).then(asr => {
      self.postMessage({ type: 'loaded', model, ms: Math.round(performance.now() - t0) });
      return asr;
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
      await load(data.model);
    } else if (data.type === 'transcribe') {
      const asr = await load(data.model);
      const t0 = performance.now();
      const text = String(await recognize(asr, data.audio)).replace(NON_SPEECH, ' ').trim();
      self.postMessage({ type: 'result', id: data.id, text, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message ?? err) });
  }
};
