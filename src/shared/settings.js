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
    // 'local': the bundled on-device speech model.
    // 'fake': test mode; text typed into the indicator stands in for speech.
    recognizer: 'local',
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

  WKV.settings = { DEFAULTS, load, save, onChange };
})(globalThis.WKV = globalThis.WKV || {});
