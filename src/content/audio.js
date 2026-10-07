// Microphone capture for the review tab.
//
// The mic stays open while voice answers are enabled on the review page (the
// browser shows its "microphone in use" indicator), so a push-to-talk press
// doesn't lose its first syllable to device start-up. Audio is only kept while
// recording, plus a short pre-roll ring buffer; it never leaves this tab
// except as the clip handed to the on-device recognizer.
//
// Output: 16 kHz mono Float32Array, which is what the speech models take.
(function (WKV) {
  'use strict';

  const TARGET_RATE = 16000;
  const ANDROID = /Android/.test(navigator.userAgent);
  const PREROLL_SEC = 0.3;
  const MAX_SEC = 10;

  // Speech detection (hands-free endpointing, and "was anything said?").
  const VAD = Object.freeze({
    minRms: 0.006,        // absolute floor, so a silent room doesn't count as speech
    startRatio: 3.0,      // speech starts at this multiple of the noise floor...
    // ...sustained this long. Measured 2026-10-04 on real recordings with 20 ms
    // frames: spoken answers (even か, め) give runs of 120-300 ms; key clicks
    // and bumps picked up by the mic stay at or under 80 ms.
    startMs: 100,
    frameMs: 20,
    endRatio: 2.0,        // speech ends when below this multiple...
    endMs: 800,           // ...for this long
  });

  // Box-filter decimation to 16 kHz: averages the input samples that fall in
  // each output sample's window. Crude, but speech models don't need better.
  function resample(chunks, inRate) {
    const length = chunks.reduce((n, c) => n + c.length, 0);
    const ratio = inRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(length / ratio));
    let chunk = 0;
    let idx = 0;
    let pos = 0; // absolute input position
    for (let o = 0; o < out.length; o++) {
      const end = Math.min(length, Math.round((o + 1) * ratio));
      let sum = 0;
      let n = 0;
      while (pos < end) {
        sum += chunks[chunk][idx];
        n += 1;
        pos += 1;
        idx += 1;
        if (idx >= chunks[chunk].length) { chunk += 1; idx = 0; }
      }
      out[o] = n ? sum / n : 0;
    }
    return out;
  }

  function rms(data) {
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i] * data[i];
    return Math.sqrt(s / data.length);
  }

  // push(level) per 20 ms frame -> { speech, quiet }; tracks the noise floor.
  function createDetector() {
    let floor = VAD.minRms;
    return {
      push(level) {
        const speech = level > Math.max(VAD.minRms, floor * VAD.startRatio);
        // Track the floor only from non-speech, slowly upward, quickly downward.
        if (!speech) floor = level < floor ? level * 0.5 + floor * 0.5 : floor * 0.98 + level * 0.02;
        floor = Math.max(floor, VAD.minRms / VAD.startRatio);
        return { speech, quiet: level < Math.max(VAD.minRms, floor * VAD.endRatio) };
      },
    };
  }

  // onLevel(rms), if given, is called for every captured chunk (~85 ms).
  function createMic({ onLevel } = {}) {
    let ctx = null;
    let stream = null;
    let source = null;
    let processor = null;
    let sink = null;
    let opening = null;
    let preroll = [];
    let prerollLen = 0;
    let recording = null; // { chunks, speechMs, onEnd, vad, quietMs, startedMs, hands }
    const detector = createDetector();

    function onAudio(e) {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      onLevel?.(rms(data));
      const frame = Math.round((ctx.sampleRate * VAD.frameMs) / 1000);
      const states = [];
      for (let i = 0; i + frame <= data.length; i += frame) {
        states.push(detector.push(rms(data.subarray(i, i + frame))));
      }
      if (!recording) {
        preroll.push(data);
        prerollLen += data.length;
        while (prerollLen - preroll[0].length > PREROLL_SEC * ctx.sampleRate) {
          prerollLen -= preroll.shift().length;
        }
        return;
      }
      const r = recording;
      r.chunks.push(data);
      for (const { speech, quiet } of states) {
        r.totalMs += VAD.frameMs;
        r.speechRunMs = speech ? r.speechRunMs + VAD.frameMs : 0;
        if (speech) r.audible = true;
        if (r.speechRunMs >= VAD.startMs) r.heardSpeech = true;
        if (r.handsFree && r.heardSpeech) r.quietMs = quiet ? r.quietMs + VAD.frameMs : 0;
      }
      if ((r.handsFree && r.quietMs >= VAD.endMs) || r.totalMs >= MAX_SEC * 1000) r.onEnd?.();
    }

    async function getStream() {
      if (WKV.testMicStream) return WKV.testMicStream(); // test builds only
      // Raw audio: noise suppression and auto-gain gate soft word onsets
      // (the h of "hand", the f of "four"), which speech models need; they
      // cope with room noise far better than with missing consonants.
      // Except auto-gain on Android: a phone's raw mic is ~25 dB quieter
      // (Pixel 9 Pro XL, 2026-10-06: speech peaks ~0.005, RMS ~0.0005, all
      // below the silence floor; with auto-gain RMS 0.05-0.08).
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: ANDROID },
        video: false,
      });
    }

    // Opens the mic (prompting for permission the first time). Safe to call
    // repeatedly.
    function open() {
      if (stream) return Promise.resolve();
      if (!opening) {
        opening = (async () => {
          const s = await getStream();
          // Firefox can't connect a MediaStream to an AudioContext running at a
          // different rate, so capture at the device rate and resample after.
          ctx = new AudioContext();
          source = ctx.createMediaStreamSource(s);
          // ScriptProcessorNode is deprecated, but an AudioWorklet would have to
          // be loaded from a URL the page's CSP allows; this needs nothing.
          processor = ctx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = onAudio;
          sink = ctx.createGain();
          sink.gain.value = 0;
          source.connect(processor);
          processor.connect(sink);
          sink.connect(ctx.destination);
          stream = s;
        })().finally(() => { opening = null; });
      }
      return opening;
    }

    function close() {
      recording = null;
      stream?.getTracks().forEach(t => t.stop());
      processor?.disconnect();
      source?.disconnect();
      sink?.disconnect();
      ctx?.close();
      ctx = stream = source = processor = sink = null;
      preroll = [];
      prerollLen = 0;
    }

    // Starts collecting audio. With handsFree, onEnd fires once speech has
    // been followed by enough quiet; it also fires at the length cap.
    async function start({ handsFree = false, onEnd } = {}) {
      await open();
      if (ctx.state === 'suspended') {
        // Autoplay policy: without a click or key press on the page, resume()
        // stays pending indefinitely. Don't hang; let the caller ask for one.
        const resumed = await Promise.race([
          ctx.resume().then(() => true),
          new Promise(r => setTimeout(() => r(false), 500)),
        ]);
        if (!resumed) {
          const err = new Error('Audio needs a click or key press on the page first');
          err.name = 'AudioBlockedError';
          throw err;
        }
      }
      recording = {
        chunks: [...preroll], totalMs: 0, speechRunMs: 0, heardSpeech: false, audible: false,
        quietMs: 0, handsFree, onEnd,
      };
      preroll = [];
      prerollLen = 0;
    }

    // Stops collecting. Returns { audio, heardSpeech, audible } or null if not
    // recording. heardSpeech: a sustained run above the noise floor (used for
    // hands-free endpointing); audible: anything above it at all. Whether a
    // clip really contains speech is decided by Silero VAD in the worker.
    function stop() {
      const r = recording;
      recording = null;
      if (!r || !ctx) return null;
      return { audio: resample(r.chunks, ctx.sampleRate), heardSpeech: r.heardSpeech, audible: r.audible };
    }

    function cancel() {
      recording = null;
    }

    return {
      open, close, start, stop, cancel,
      isOpen: () => !!stream,
      isRecording: () => !!recording,
    };
  }

  WKV.audio = { createMic, resample, TARGET_RATE };
})(globalThis.WKV = globalThis.WKV || {});
