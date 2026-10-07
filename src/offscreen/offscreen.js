// CHROME ONLY. The offscreen document that hosts the speech worker
// (src/background/offscreen-host.js explains why). It only relays: messages
// from the service worker go to the worker, the worker's messages go back.
// Offscreen documents get no extension API but `runtime`, which is all this
// needs.
const worker = new Worker(chrome.runtime.getURL('dist/asr-worker.js'), { type: 'module' });

const send = message => chrome.runtime.sendMessage({ target: 'wkv-background', ...message }).catch(() => {
  // The service worker is restarting; it asks again for what it needs.
});

worker.onmessage = ({ data }) => send({ data });
worker.onerror = e => send({ error: e.message || 'speech worker crashed' });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'wkv-offscreen') return false;
  const { data } = msg;
  if (typeof data.audio === 'string') {
    const audio = WKV.wire.unpackAudio(data.audio); // src/shared/wire.js
    worker.postMessage({ ...data, audio }, [audio.buffer]);
  } else {
    worker.postMessage(data);
  }
  return false;
});
