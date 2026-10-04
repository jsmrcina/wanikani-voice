// Whisper decoding shared by the extension's worker and tools/eval-asr.mjs,
// so offline evaluation measures exactly what the extension does.

// A fixed decoder prompt nudges Whisper toward short dictionary-style answers
// ("Hand." rather than "And", "Sun." rather than "Son."). It is the same for
// every question and never contains anything from the page. Its words are
// deliberately absent from the evaluation set; measured 2026-10-04 on real
// recordings: 21/25 -> 22/25 raw, 18/25 -> 20/25 through a noise gate.
export const PROMPT = ' Rain. Old man. Dog. To run. Heart. Seven. Leaf. Blue.';
const promptCache = new WeakMap(); // pipeline -> decoder_input_ids

function decoderPrompt(asr) {
  if (!promptCache.has(asr)) {
    const tok = asr.tokenizer;
    const special = t => tok.encode(t, { add_special_tokens: false })[0];
    promptCache.set(asr, [[
      special('<|startofprev|>'),
      ...tok.encode(PROMPT, { add_special_tokens: false }),
      special('<|startoftranscript|>'),
      special('<|notimestamps|>'),
    ]]);
  }
  return promptCache.get(asr);
}

export async function recognize(asr, audio) {
  const inputs = await asr.processor(audio);
  const prompt = decoderPrompt(asr);
  const ids = (await asr.model.generate({ ...inputs, decoder_input_ids: prompt, max_new_tokens: 24 })).tolist()[0].map(Number);
  // generate() returns the prompt too; keep only what follows it.
  return asr.tokenizer.decode(ids.slice(prompt[0].length), { skip_special_tokens: true });
}

