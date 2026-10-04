// TEST BUILD ONLY (added by test/run_tests.py, never shipped): lets the test
// page read/write extension settings, since WebDriver can't drive
// moz-extension:// pages.
window.addEventListener('message', async e => {
  if (e.source !== window || e.data?.type !== 'wkv-test:settings') return;
  if (e.data.replace) {
    await browser.storage.local.clear();
    await browser.storage.local.set(e.data.replace);
  }
  const stored = await browser.storage.local.get();
  window.postMessage({ type: 'wkv-test:settings-result', id: e.data.id, stored }, '*');
});
