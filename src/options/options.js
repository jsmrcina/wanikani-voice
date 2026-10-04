(function (WKV) {
  'use strict';

  const $ = id => document.getElementById(id);
  // Keys that would break typing answers or WaniKani's own shortcuts.
  const RESERVED = new Set(['Enter', 'NumpadEnter', 'Backspace', 'Tab', 'Escape',
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'CapsLock']);
  let capturing = false;

  function render(s) {
    $('enabled').checked = s.enabled;
    for (const name of ['inputMode', 'submitMode', 'recognizer']) {
      const radio = document.querySelector(`input[name="${name}"][value="${s[name]}"]`);
      if (radio) radio.checked = true;
    }
    $('pttKey').textContent = s.pttKey;
    $('autoAdvance').checked = s.autoAdvance;
    $('autoAdvanceDelay').value = s.autoAdvanceDelayMs / 1000;
    $('autoAdvanceDelay').disabled = !s.autoAdvance;
  }

  function bind() {
    const save = WKV.settings.save;
    $('enabled').addEventListener('change', e => save({ enabled: e.target.checked }));
    for (const name of ['inputMode', 'submitMode', 'recognizer']) {
      for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
        radio.addEventListener('change', e => save({ [name]: e.target.value }));
      }
    }
    $('autoAdvance').addEventListener('change', e => save({ autoAdvance: e.target.checked }));
    $('autoAdvanceDelay').addEventListener('change', e => {
      const seconds = Math.min(10, Math.max(0, Number(e.target.value) || 0));
      save({ autoAdvanceDelayMs: Math.round(seconds * 1000) });
    });

    const pttButton = $('pttKey');
    pttButton.addEventListener('click', () => {
      capturing = true;
      pttButton.classList.add('capturing');
      pttButton.textContent = 'Press a key…';
    });
    pttButton.addEventListener('keydown', e => {
      if (!capturing) return;
      e.preventDefault();
      if (e.code === 'Escape') {
        capturing = false;
        pttButton.classList.remove('capturing');
        WKV.settings.load().then(render);
        return;
      }
      if (RESERVED.has(e.code)) {
        $('ptt-help').textContent = `${e.code} can't be used; pick another key`;
        return;
      }
      capturing = false;
      pttButton.classList.remove('capturing');
      $('ptt-help').textContent = 'Click, then press the key to use';
      save({ pttKey: e.key === 'Shift' ? 'Shift' : e.code });
    });
  }

  bind();
  WKV.settings.load().then(render);
  WKV.settings.onChange(render);
})(globalThis.WKV = globalThis.WKV || {});
