// Custom (e.g. voice-tuned) speech models chosen in the settings: validated
// and kept in the extension's own IndexedDB, so they never leave the
// computer. The settings page installs them; the speech worker reads them.
//
// Model file: a .wkv-model.zip (made by tools/pack-model.mjs) holding the
// model's files plus wkv-model.json:
//   { "format": 1, "language": "en" | "ja-kana", "kind": "whisper" | "moonshine" | "ctc", "name": "..." }
//
// IndexedDB "wkv-custom-models", store "models", one record per language:
//   { slot, id, name, kind, files: { path: ArrayBuffer }, size, addedAt }
// A summary (no files) also goes to settings.customModels[slot], so the
// background page notices changes through storage.onChanged.
// Classic script: attaches WKV.modelStore.
(function (WKV) {
  'use strict';

  const DB = 'wkv-custom-models';
  const STORE = 'models';
  // The kinds of model each language accepts.
  const SLOTS = { en: ['whisper', 'moonshine'], 'ja-kana': ['ctc'] };
  // Files transformers.js loads for each kind (8-bit "q8" variants).
  const SEQ2SEQ = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json',
    'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
  const REQUIRED = { whisper: SEQ2SEQ, moonshine: SEQ2SEQ, ctc: ['config.json', 'onnx/model_quantized.onnx'] };
  const MAX_BYTES = 600 * 1024 * 1024;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slot' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const result = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(result.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('storage transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  const get = slot => tx('readonly', s => s.get(slot));

  // Checks a model file's contents; returns { meta, files } or throws with a
  // message meant for the settings page.
  function validate(slot, files) {
    const text = path => new TextDecoder().decode(files.get(path));
    if (!files.has('wkv-model.json')) throw new Error('not a model file (no wkv-model.json); make one with tools/pack-model.mjs');
    let meta;
    try { meta = JSON.parse(text('wkv-model.json')); } catch { throw new Error('wkv-model.json is not valid JSON'); }
    if (meta.format !== 1) throw new Error(`unsupported model file format ${meta.format}`);
    if (meta.language !== slot) {
      throw new Error(`this is a model for ${meta.language === 'en' ? 'English' : 'readings'}, not ${slot === 'en' ? 'English' : 'readings'}`);
    }
    if (!SLOTS[slot].includes(meta.kind)) throw new Error(`a ${meta.kind} model can't be used for ${slot}`);
    const missing = REQUIRED[meta.kind].filter(f => !files.has(f));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
    let config;
    try { config = JSON.parse(text('config.json')); } catch { throw new Error('config.json is not valid JSON'); }
    if (meta.kind !== 'ctc' && config.model_type !== meta.kind) {
      throw new Error(`config.json is not a ${meta.kind === 'whisper' ? 'Whisper' : 'Moonshine'} model`);
    }
    if (meta.kind === 'ctc' && !Array.isArray(config.kana_vocab?.tokens)) {
      throw new Error('config.json has no kana vocabulary (export with tools/export-dual-ctc.py)');
    }
    return meta;
  }

  // Installs a model file for a language. zipBytes: ArrayBuffer.
  async function install(slot, zipBytes, fileName = '') {
    if (!(slot in SLOTS)) throw new Error(`unknown language ${slot}`);
    if (zipBytes.byteLength > MAX_BYTES) throw new Error('model file is too large');
    const entries = await WKV.zip.read(zipBytes);
    const meta = validate(slot, entries);
    const files = {};
    let size = 0;
    for (const path of REQUIRED[meta.kind]) {
      const data = entries.get(path);
      files[path] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      size += data.byteLength;
    }
    const addedAt = Date.now();
    // A new id per install, so the worker never reuses a previous model.
    const record = { slot, id: `custom-${slot}-${addedAt}`, name: meta.name || fileName, kind: meta.kind, files, size, addedAt };
    await tx('readwrite', s => s.put(record));
    const { customModels = {} } = await browser.storage.local.get('customModels');
    customModels[slot] = { id: record.id, name: record.name, kind: record.kind, size, addedAt };
    await browser.storage.local.set({ customModels });
    return customModels[slot];
  }

  async function remove(slot) {
    await tx('readwrite', s => s.delete(slot));
    const { customModels = {} } = await browser.storage.local.get('customModels');
    delete customModels[slot];
    await browser.storage.local.set({ customModels });
  }

  WKV.modelStore = { SLOTS, REQUIRED, get, install, remove, validate };
})(globalThis.WKV = globalThis.WKV || {});
