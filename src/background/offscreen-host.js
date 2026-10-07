// CHROME ONLY (loaded by service-worker.js). A Chrome MV3 background is a
// service worker, which can't start the speech worker and is stopped when
// idle. The speech worker runs in an offscreen document instead
// (src/offscreen/), which Chrome keeps open (reason WORKERS has no time
// limit), so the models stay loaded while the service worker comes and goes.
//
// WKV.createSpeechWorker() returns a stand-in with a Worker's interface
// (postMessage, onmessage, onerror) that relays to the real one. After a
// service-worker restart the background simply asks for its models again;
// the worker answers at once from the models it already holds.
(function (WKV) {
  'use strict';

  const PAGE = 'src/offscreen/offscreen.html';
  let creating = null;
  let current = null; // the stand-in currently in use

  async function ensureDocument() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(PAGE)],
    });
    if (contexts.length) return;
    creating ??= chrome.offscreen.createDocument({
      url: PAGE, reasons: ['WORKERS'],
      justification: 'Runs the on-device speech recognition worker',
    }).finally(() => { creating = null; });
    await creating;
  }

  // Replies from the offscreen document (one listener for all stand-ins).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id || msg?.target !== 'wkv-background' || !current) return false;
    if (msg.error) current.onerror?.({ message: msg.error });
    else current.onmessage?.({ data: msg.data });
    return false;
  });

  WKV.createSpeechWorker = () => {
    let queue = Promise.resolve(); // keeps messages in order
    const host = {
      onmessage: null,
      onerror: null,
      postMessage(data) {
        const msg = data.audio instanceof Float32Array ? { ...data, audio: WKV.wire.packAudio(data.audio) } : data;
        queue = queue
          .then(ensureDocument)
          .then(() => chrome.runtime.sendMessage({ target: 'wkv-offscreen', data: msg }))
          .catch(err => host.onerror?.({ message: `speech worker unavailable: ${err?.message ?? err}` }));
      },
    };
    current = host;
    return host;
  };
})(globalThis.WKV = globalThis.WKV || {});
