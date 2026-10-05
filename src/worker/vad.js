// Silero VAD (v5, MIT, ~2 MB ONNX): decides whether a finished clip contains
// speech before it reaches a recogniser. The page's energy detector can only
// tell a key click (≤ 80 ms) from a short syllable (≥ 120 ms) by a thin
// margin. Silero separates them cleanly: on the real recordings
// (2026-10-04) the click-only silence clip peaks at p = 0.04 with no speech
// windows, while every spoken answer, even か and て, has ≥ 160 ms of
// continuous speech at p ≈ 0.99.
//
// `ort` is onnxruntime-web (extension) or onnxruntime-node (tools), so the
// evaluation tool gates clips exactly like the extension does.

const WINDOW = 512;   // samples per step at 16 kHz (32 ms)
const CONTEXT = 64;   // samples carried over from the previous window
const THRESHOLD = 0.5;
// Speech must last at least this long (3 windows). Shortest real answer: 160 ms.
export const MIN_SPEECH_MS = 96;

export async function createVad(ort, modelPathOrBytes) {
  const session = await ort.InferenceSession.create(modelPathOrBytes);
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);

  // Longest run of speech in a 16 kHz clip, in ms.
  async function longestSpeechMs(audio) {
    let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    let context = new Float32Array(CONTEXT);
    let run = 0;
    let longest = 0;
    for (let i = 0; i + WINDOW <= audio.length; i += WINDOW) {
      const x = new Float32Array(CONTEXT + WINDOW);
      x.set(context);
      x.set(audio.subarray(i, i + WINDOW), CONTEXT);
      const out = await session.run({ input: new ort.Tensor('float32', x, [1, CONTEXT + WINDOW]), state, sr });
      state = out.stateN;
      context = audio.slice(i + WINDOW - CONTEXT, i + WINDOW);
      run = out.output.data[0] > THRESHOLD ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    return (longest * WINDOW * 1000) / 16000;
  }

  return {
    longestSpeechMs,
    async hasSpeech(audio) {
      return (await longestSpeechMs(audio)) >= MIN_SPEECH_MS;
    },
  };
}
