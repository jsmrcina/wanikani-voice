// TEST BUILD ONLY (added by test/run_tests.py, never shipped).
//
// - lets the test page read/write extension settings, since WebDriver can't
//   drive moz-extension:// pages
// - replaces the microphone with a stream the test can play WAV clips into
// - forwards a diagnostics request to the background page
//
// Content scripts of one extension share a sandbox, so WKV here is the same
// object the extension's content scripts use.
const WKV = (globalThis.WKV = globalThis.WKV || {});
let fakeMic = null;

WKV.testMicStream = async () => {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  fakeMic = { ctx, dest };
  return dest.stream;
};

async function say(url) {
  if (!fakeMic) throw new Error('mic not open');
  const { ctx, dest } = fakeMic;
  const data = await (await fetch(url)).arrayBuffer();
  const buffer = await ctx.decodeAudioData(data);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start();
  return buffer.duration;
}

window.addEventListener('message', async e => {
  if (e.source !== window || typeof e.data?.type !== 'string' || !e.data.type.startsWith('wkv-test:')) return;
  if (e.data.type.endsWith('-result')) return;
  let result;
  try {
    if (e.data.type === 'wkv-test:settings') {
      if (e.data.replace) {
        await browser.storage.local.clear();
        await browser.storage.local.set(e.data.replace);
      }
      result = await browser.storage.local.get();
    } else if (e.data.type === 'wkv-test:say') {
      result = await say(e.data.url);
    } else if (e.data.type === 'wkv-test:diag') {
      result = await browser.runtime.sendMessage({ type: 'wkv:diag' });
    }
  } catch (err) {
    result = { error: String(err) };
  }
  window.postMessage({ type: `${e.data.type}-result`, id: e.data.id, result }, '*');
});
