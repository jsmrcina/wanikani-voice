// Background page: owns recognition and keyboard commands.
//
// The recognizer's input is deliberately narrow: a mode ('en' | 'ja-kana') and
// the user's speech. Nothing from the page (no question, no item) is ever part
// of a transcribe request; see src/content/main.js.
(function (WKV) {
  'use strict';

  // Which bundled model handles each mode, and what kind of model it is.
  const MODELS = { en: 'whisper-base.en', 'ja-kana': 'distilhubert-hiragana' };
  const KINDS = { 'whisper-base.en': 'whisper', 'distilhubert-hiragana': 'ctc' };
  const MAX_CHOICES = 3;
  const MODES = new Set(Object.keys(MODELS));

  // ---- worker ---------------------------------------------------------------

  let worker = null;
  let nextId = 1;
  const pending = new Map();      // id -> { resolve }
  const modelState = new Map();   // model -> { status, loaded, total, ms, message }
  const sessions = new Set();     // open ports from review tabs

  function broadcast(model) {
    const msg = { type: 'model', model, ...modelState.get(model) };
    for (const port of sessions) port.postMessage(msg);
  }

  function setModelState(model, patch) {
    modelState.set(model, { ...modelState.get(model), ...patch });
    broadcast(model);
  }

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(browser.runtime.getURL('dist/asr-worker.js'), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        setModelState(data.model, { status: 'loading', loaded: data.loaded, total: data.total });
      } else if (data.type === 'loaded') {
        setModelState(data.model, { status: 'ready', ms: data.ms });
      } else if (data.type === 'result' || data.type === 'error') {
        if (data.id === undefined) {
          for (const [model, s] of modelState) {
            if (s.status === 'loading') setModelState(model, { status: 'error', message: data.message });
          }
          return;
        }
        pending.get(data.id)?.resolve(data);
        pending.delete(data.id);
      }
    };
    worker.onerror = e => {
      e.message ??= 'speech worker crashed';
      console.error('[wkv] speech worker failed', e.message);
      for (const { resolve } of pending.values()) resolve({ type: 'error', message: e.message });
      pending.clear();
      for (const model of modelState.keys()) setModelState(model, { status: 'error', message: e.message });
      worker = null;
    };
    return worker;
  }

  function loadModel(model) {
    const s = modelState.get(model);
    if (s?.status === 'ready' || s?.status === 'loading') {
      broadcast(model);
      return;
    }
    setModelState(model, { status: 'loading', loaded: 0, total: 0 });
    getWorker().postMessage({ type: 'load', model, kind: KINDS[model] });
  }

  function runWorker(model, audio) {
    return new Promise(resolve => {
      const id = nextId++;
      pending.set(id, { resolve });
      getWorker().postMessage({ type: 'transcribe', id, model, kind: KINDS[model], audio }, [audio.buffer]);
    });
  }

  // ---- requests -------------------------------------------------------------

  async function transcribe(msg) {
    if (!MODES.has(msg.mode)) return { ok: false, reason: 'Unknown mode' };
    const settings = await WKV.settings.load();
    let candidates;
    let ms;
    if (settings.recognizer === 'fake') {
      // Test mode: "a|b|c" stands in for a recogniser offering alternatives.
      candidates = String(msg.fakeUtterance ?? '').split('|');
    } else {
      const model = MODELS[msg.mode];
      if (!model) return { ok: false, reason: 'No speech model for this question type' };
      if (!(msg.audio instanceof Float32Array) || msg.audio.length === 0) {
        return { ok: false, reason: "Didn't catch that" };
      }
      // Copy: the incoming array may not be transferable from this context.
      const res = await runWorker(model, new Float32Array(msg.audio));
      if (res.type === 'error') return { ok: false, reason: `Recognizer error: ${res.message}` };
      candidates = res.candidates;
      ms = res.ms;
    }
    // Normalise every candidate; keep the valid, distinct ones, best first.
    const normalized = candidates.map(c => WKV.normalize.normalizeAnswer(c, msg.mode));
    const choices = [...new Set(normalized.filter(n => n.ok).map(n => n.text))].slice(0, MAX_CHOICES);
    if (!choices.length) return { raw: candidates[0], ms, ...normalized[0] };
    return { ok: true, raw: candidates[0], ms, text: choices[0], choices };
  }

  const startedAt = Date.now();

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    if (msg?.type === 'wkv:transcribe') return transcribe(msg);
    // Diagnostics (used by tests): is this the same background instance, and
    // what state are the models in?
    if (msg?.type === 'wkv:diag') {
      return Promise.resolve({ startedAt, workerAlive: !!worker, models: Object.fromEntries(modelState) });
    }
    return undefined;
  });

  // A review tab keeps a port open for its whole session. That lets the
  // background push model-loading progress, and an open port keeps Firefox
  // from unloading this (non-persistent) page and the loaded model with it.
  browser.runtime.onConnect.addListener(port => {
    if (port.sender?.id !== browser.runtime.id || port.name !== 'wkv-session') return;
    sessions.add(port);
    port.onDisconnect.addListener(() => sessions.delete(port));
    port.onMessage.addListener(async msg => {
      if (msg?.type !== 'warmup') return;
      port.postMessage({ type: 'capabilities', modes: MODELS });
      const settings = await WKV.settings.load();
      if (settings.recognizer === 'fake') return;
      for (const model of Object.values(MODELS)) if (model) loadModel(model);
    });
  });

  browser.commands.onCommand.addListener(async command => {
    if (command !== 'toggle-enabled') return;
    const { enabled } = await WKV.settings.load();
    await WKV.settings.save({ enabled: !enabled });
  });

})(globalThis.WKV = globalThis.WKV || {});
