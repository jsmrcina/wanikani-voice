// Custom (e.g. voice-tuned) speech models chosen in the settings: validated
// and kept in the extension's own IndexedDB, so they never leave the
// computer. The settings page installs them; the speech worker reads them.
//
// Model file: a .wkv-model.zip (made by tools/pack-model.mjs) holding the
// model's files plus wkv-model.json:
//   { "format": 1, "language": "en" | "ja-kana", "kind": "whisper" | "moonshine" | "ctc", "name": "..." }
// Format 1 models are 8-bit. Format 2 adds the precision of each ONNX file,
// as transformers.js names them, e.g. for a full-precision Moonshine:
//   "dtype": { "encoder_model": "fp32", "decoder_model_merged": "fp32" }
// (a file left out is 8-bit).
//
// IndexedDB "wkv-custom-models", store "models", one record per language:
//   { slot, id, name, kind, dtype, files: { path: ArrayBuffer }, size, addedAt }
// A summary (no files) also goes to settings.customModels[slot], so the
// background page notices changes through storage.onChanged.
// Classic script: attaches WKV.modelStore.
(function (WKV) {
  'use strict';

  const DB = 'wkv-custom-models';
  const STORE = 'models';
  // The kinds of model each language accepts.
  const SLOTS = { en: ['whisper', 'moonshine'], 'ja-kana': ['ctc'] };
  // Files transformers.js loads for each kind: the configs, and each ONNX
  // part in the precision chosen for it.
  const SEQ2SEQ = { configs: ['config.json', 'generation_config.json', 'preprocessor_config.json',
    'tokenizer.json', 'tokenizer_config.json'], parts: ['encoder_model', 'decoder_model_merged'] };
  const KINDS = { whisper: SEQ2SEQ, moonshine: SEQ2SEQ, ctc: { configs: ['config.json'], parts: ['model'] } };
  // ONNX file suffix of each precision.
  const SUFFIX = { q8: '_quantized', fp16: '_fp16', fp32: '' };

  // The precision of every part of a kind of model: dtype as in
  // wkv-model.json, 8-bit where it says nothing.
  function fullDtype(kind, dtype = {}) {
    return Object.fromEntries(KINDS[kind].parts.map(part => [part, dtype[part] ?? 'q8']));
  }

  function requiredFiles(kind, dtype) {
    const parts = Object.entries(fullDtype(kind, dtype)).map(([part, d]) => `onnx/${part}${SUFFIX[d]}.onnx`);
    return [...KINDS[kind].configs, ...parts];
  }
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
    if (meta.format !== 1 && meta.format !== 2) throw new Error(`unsupported model file format ${meta.format}`);
    if (meta.language !== slot) {
      const name = lang => (lang === 'en' ? 'English' : 'readings');
      throw new Error(`this is a model for ${name(meta.language)}, not ${name(slot)}: choose it under ${name(meta.language)[0].toUpperCase()}${name(meta.language).slice(1)}`);
    }
    if (!SLOTS[slot].includes(meta.kind)) throw new Error(`a ${meta.kind} model can't be used for ${slot}`);
    if (meta.format === 1) delete meta.dtype;
    const dtype = meta.dtype ?? {};
    if (!dtype || typeof dtype !== 'object' || Array.isArray(dtype)) throw new Error('wkv-model.json: dtype must be an object');
    for (const [part, d] of Object.entries(dtype)) {
      if (!KINDS[meta.kind].parts.includes(part)) throw new Error(`wkv-model.json: a ${meta.kind} model has no part ${part}`);
      if (!(d in SUFFIX)) throw new Error(`wkv-model.json: unknown precision ${d} for ${part}`);
    }
    const missing = requiredFiles(meta.kind, dtype).filter(f => !files.has(f));
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
    for (const path of requiredFiles(meta.kind, meta.dtype)) {
      const data = entries.get(path);
      files[path] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      size += data.byteLength;
    }
    const addedAt = Date.now();
    // A new id per install, so the worker never reuses a previous model.
    const record = { slot, id: `custom-${slot}-${addedAt}`, name: meta.name || fileName, kind: meta.kind,
      dtype: fullDtype(meta.kind, meta.dtype), files, size, addedAt };
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

  WKV.modelStore = { SLOTS, SUFFIX, fullDtype, requiredFiles, get, install, remove, validate };
})(globalThis.WKV = globalThis.WKV || {});
