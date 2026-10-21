// Settings: import or remove the WaniKani dictionary (a .wkv-dict.json made
// by tools/wk-dictionary.mjs from the user's own API token). Its meanings
// and readings go to storage.local "dictionary", which the background reads
// to rank answers (src/background/background.js); a summary goes to
// settings.dictionaryInfo. Nothing here touches the network.
(function (WKV) {
  'use strict';

  const fieldset = document.getElementById('dictionary');
  const status = fieldset.querySelector('.dictionary-status');
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_ENTRIES = 200000;
  // Opened from the toolbar button, the settings are a popup that closes when
  // a file chooser opens (see custom-models.js); choose the file in a tab.
  const IN_POPUP = new URLSearchParams(location.search).has('popup');

  // Checks a dictionary file's contents; returns { meanings, readings, info }
  // or throws with a message for the settings page.
  function validate(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('not a JSON file'); }
    if (data?.kind !== 'wkv-dictionary') throw new Error('not a dictionary file (make one with tools/wk-dictionary.mjs)');
    if (data.format !== 1) throw new Error(`unsupported dictionary format ${data.format}`);
    const list = name => {
      const value = data[name];
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length > 200)) {
        throw new Error(`${name} must be a list of short strings`);
      }
      return value;
    };
    const meanings = list('meanings');
    const readings = list('readings');
    if (meanings.length + readings.length > MAX_ENTRIES) throw new Error('too many entries');
    if (!meanings.length && !readings.length) throw new Error('the dictionary is empty');
    return {
      meanings, readings,
      info: { meanings: meanings.length, readings: readings.length, subjects: Number(data.subjects) || null,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : null, importedAt: Date.now() },
    };
  }

  function render(settings) {
    const info = settings.dictionaryInfo;
    if (status.classList.contains('busy')) return;
    status.classList.remove('error');
    status.textContent = info
      ? `${info.meanings} meanings, ${info.readings} readings` +
        (info.createdAt ? ` (from WaniKani ${new Date(info.createdAt).toLocaleDateString()})` : '')
      : 'none imported';
    fieldset.querySelector('.reset').disabled = !info;
  }
  const show = (text, kind = '') => {
    status.textContent = text;
    status.className = `dictionary-status ${kind}`;
  };

  if (IN_POPUP) {
    fieldset.querySelector('label.button').addEventListener('click', async e => {
      e.preventDefault();
      await browser.tabs.create({ url: browser.runtime.getURL('src/options/options.html#dictionary') });
      window.close();
    });
  }

  fieldset.querySelector('input[type=file]').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    show(`checking ${file.name}…`, 'busy');
    try {
      if (file.size > MAX_BYTES) throw new Error('file is too large');
      const { meanings, readings, info } = validate(await file.text());
      await browser.storage.local.set({ dictionary: { meanings, readings } });
      status.classList.remove('busy');
      await WKV.settings.save({ dictionaryInfo: info, useDictionary: true });
    } catch (err) {
      show(`can't use ${file.name}: ${err.message}`, 'error');
    }
  });

  fieldset.querySelector('.reset').addEventListener('click', async () => {
    await browser.storage.local.remove('dictionary');
    await WKV.settings.save({ dictionaryInfo: null, useDictionary: false });
  });

  WKV.dictionary = { validate };
  WKV.settings.load().then(render);
  WKV.settings.onChange(render);
})(globalThis.WKV = globalThis.WKV || {});
