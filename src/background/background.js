// Background page: owns recognition and keyboard commands.
//
// The recognizer's input is deliberately narrow: a mode ('en' | 'ja-kana')
// and the user's speech. Nothing from the page (no question, no item) is ever
// part of a transcribe request — see messages in src/content/main.js.
(function (WKV) {
  'use strict';

  const MODES = new Set(['en', 'ja-kana']);

  // Phase 1 stand-in for a speech model. `utterance` is text the user typed
  // into the indicator's test field, playing the role of audio.
  async function fakeRecognize(utterance) {
    return String(utterance ?? '');
  }

  async function transcribe(msg) {
    if (!MODES.has(msg.mode)) return { ok: false, reason: 'Unknown mode' };
    const settings = await WKV.settings.load();
    let raw;
    if (settings.recognizer === 'fake') {
      raw = await fakeRecognize(msg.fakeUtterance);
    } else {
      return { ok: false, reason: 'No speech model yet' };
    }
    return { raw, ...WKV.normalize.normalizeAnswer(raw, msg.mode) };
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    if (msg?.type === 'wkv:transcribe') return transcribe(msg);
    return undefined;
  });

  browser.commands.onCommand.addListener(async command => {
    if (command !== 'toggle-enabled') return;
    const { enabled } = await WKV.settings.load();
    await WKV.settings.save({ enabled: !enabled });
  });
})(globalThis.WKV = globalThis.WKV || {});
