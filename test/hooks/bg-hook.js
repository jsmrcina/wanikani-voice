// TEST BUILD ONLY (added to the background by test/run_tests.py, never
// shipped): lets tests install or remove custom models through the same
// WKV.modelStore code the settings page uses.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return false;
  let reply;
  if (msg?.type === 'wkv-test:install-custom') {
    // From the local test server; the test build's CSP allows only that.
    reply = fetch(msg.url).then(r => r.arrayBuffer())
      .then(bytes => WKV.modelStore.install(msg.slot, bytes, msg.name))
      .then(meta => ({ ok: true, meta }), err => ({ ok: false, error: err.message }));
  } else if (msg?.type === 'wkv-test:remove-custom') {
    reply = WKV.modelStore.remove(msg.slot).then(() => ({ ok: true }));
  } else return false;
  reply.then(sendResponse);
  return true;
});
