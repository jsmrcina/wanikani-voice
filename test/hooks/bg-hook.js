// TEST BUILD ONLY (added to the background by test/run_tests.py, never
// shipped): lets tests install or remove custom models through the same
// WKV.modelStore code the settings page uses.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (msg?.type === 'wkv-test:install-custom') {
    return WKV.modelStore.install(msg.slot, msg.bytes, msg.name)
      .then(meta => ({ ok: true, meta }), err => ({ ok: false, error: err.message }));
  }
  if (msg?.type === 'wkv-test:remove-custom') {
    return WKV.modelStore.remove(msg.slot).then(() => ({ ok: true }));
  }
  return undefined;
});
