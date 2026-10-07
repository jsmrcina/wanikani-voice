// User settings, stored in storage.local (never storage.sync: Firefox Sync
// would copy them to Mozilla's servers, and nothing leaves the device).
(function (WKV) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    // 'push-to-talk': hold pttKey while speaking.
    // 'voice-activity': listen automatically on each new question.
    inputMode: 'push-to-talk',
    // 'Shift' = either Shift key; otherwise a KeyboardEvent.code ('KeyJ', ...).
    pttKey: 'Shift',
    // 'fill-only': put the answer in the box and let the user press Enter.
    // 'auto-submit': also submit it.
    submitMode: 'fill-only',
    // After an answer is graded, move to the next question automatically.
    autoAdvance: false,
    autoAdvanceDelayMs: 1500,
    // Only auto-advance when WaniKani marked the answer correct, so a wrong
    // answer stays on screen until the user moves on.
    autoAdvanceOnlyCorrect: false,
    // Where the panel sits: 'top-right', 'top-left', 'bottom-right', 'bottom-left'.
    indicatorPosition: 'top-right',
    // Custom models chosen in the settings, per language ('en', 'ja-kana'):
    // { id, name, kind, size, addedAt }; the files are in IndexedDB
    // (src/shared/model-store.js).
    customModels: {},
    // English model: 'fast' (Moonshine base, the default since 2026-10-06:
    // ~0.1 s per answer on a desktop, ~0.3 s on a phone) or 'accurate'
    // (Whisper base.en: ~1.6 s and ~4 s, offers the right answer slightly
    // more often).
    englishSpeed: 'fast',
    // 'local': the bundled on-device speech model.
    // 'fake': test mode; text typed into the indicator stands in for speech.
    recognizer: 'local',
  });

  // Different first-run defaults on Firefox for Android (touch, small
  // screen). Applied once, at install, and only to settings the user hasn't
  // set; see background.js.
  const ANDROID_DEFAULTS = Object.freeze({
    indicatorPosition: 'bottom-right',
    inputMode: 'push-to-talk',
  });

  async function load() {
    const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  }

  function save(partial) {
    return browser.storage.local.set(partial);
  }

  // Calls cb(fullSettings) whenever any setting changes.
  function onChange(cb) {
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      if (!Object.keys(changes).some(k => k in DEFAULTS)) return;
      cb(await load());
    });
  }

  WKV.settings = { DEFAULTS, ANDROID_DEFAULTS, load, save, onChange };
})(globalThis.WKV = globalThis.WKV || {});
