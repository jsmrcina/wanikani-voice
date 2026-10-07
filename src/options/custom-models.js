// Settings: choose or reset a custom model per language (WKV.modelStore).
(function (WKV) {
  'use strict';

  const BUILT_IN = { en: 'built-in (Moonshine or Whisper, by English speed)', 'ja-kana': 'built-in (hiragana model)' };
  const mb = n => `${(n / 1024 / 1024).toFixed(0)} MB`;
  // Opened from the toolbar button, this page is a popup, and Firefox closes
  // a popup as soon as a file chooser opens: the chosen file never arrives,
  // with no error (seen 2026-10-07). There, "Choose file…" opens the
  // settings in a tab instead.
  const IN_POPUP = new URLSearchParams(location.search).has('popup');

  function render(settings) {
    for (const row of document.querySelectorAll('.model-row')) {
      const meta = settings.customModels?.[row.dataset.slot];
      const status = row.querySelector('.model-status');
      if (status.classList.contains('busy')) continue;
      status.classList.remove('error');
      status.textContent = meta
        ? `custom: ${meta.name} (${mb(meta.size)}, ${new Date(meta.addedAt).toLocaleDateString()})`
        : BUILT_IN[row.dataset.slot];
      row.querySelector('.reset').disabled = !meta;
    }
  }

  for (const row of document.querySelectorAll('.model-row')) {
    const slot = row.dataset.slot;
    const status = row.querySelector('.model-status');
    const show = (text, kind = '') => {
      status.textContent = text;
      status.className = `model-status ${kind}`;
    };
    if (IN_POPUP) {
      const picker = row.querySelector('label.button');
      picker.title = 'Opens the settings in a tab, where a file can be chosen';
      picker.addEventListener('click', async e => {
        e.preventDefault();
        await browser.tabs.create({ url: browser.runtime.getURL('src/options/options.html#custom-models') });
        window.close();
      });
    }
    row.querySelector('input[type=file]').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      show(`checking ${file.name}…`, 'busy');
      try {
        await WKV.modelStore.install(slot, await file.arrayBuffer(), file.name.replace(/\.wkv-model\.zip$|\.zip$/, ''));
        status.classList.remove('busy');
        render(await WKV.settings.load());
      } catch (err) {
        show(`can't use ${file.name}: ${err.message}`, 'error');
      }
    });
    row.querySelector('.reset').addEventListener('click', async () => {
      await WKV.modelStore.remove(slot);
      render(await WKV.settings.load());
    });
  }

  WKV.settings.load().then(render);
  WKV.settings.onChange(render);
})(globalThis.WKV = globalThis.WKV || {});
