// Speech decoding shared by the extension's worker and tools/eval-asr.mjs,
// so offline evaluation measures exactly what the extension does.
import { ctcBeamSearch } from './ctc.js';

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


// ---- Japanese readings: Whisper constrained to hiragana --------------------
//
// Multilingual Whisper writes Japanese with kanji (人), and turning that back
// into a reading would mean guessing (じん / にん / ひと), which is exactly what
// is being tested. Instead, decoding may only produce hiragana: a UTF-8 state
// machine over Whisper's byte-level tokens allows a token only if its bytes
// continue a valid sequence of U+3041–U+3096 (or a space). Kanji, katakana,
// ー and Latin text can't be generated at all, and end-of-text is blocked while
// a character is half-written. Normalisation still validates the result.

// GPT-2 byte-level BPE stores each byte as a printable code point.
function byteDecoder() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  return new Map(cs.map((c, i) => [String.fromCodePoint(c), bs[i]]));
}

// States: 0 = between characters, 1 = after E3, 2 = after E3 81, 3 = after E3 82.
// U+3041–U+307F = E3 81 81–BF; U+3080–U+3096 = E3 82 80–96.
function step(state, b) {
  switch (state) {
    case 0: return b === 0x20 ? 0 : b === 0xe3 ? 1 : -1;
    case 1: return b === 0x81 ? 2 : b === 0x82 ? 3 : -1;
    case 2: return b >= 0x81 && b <= 0xbf ? 0 : -1;
    case 3: return b >= 0x80 && b <= 0x96 ? 0 : -1;
    default: return -1;
  }
}

function run(state, bytes) {
  for (const b of bytes) {
    state = step(state, b);
    if (state < 0) return -1;
  }
  return state;
}

// Precomputes, for each state, which token ids are forbidden.
export function hiraganaConstraint(tokenizerJson) {
  const decoder = byteDecoder();
  const special = new Set((tokenizerJson.added_tokens ?? []).map(t => t.id));
  const tokenBytes = new Map(); // id -> byte array (ordinary tokens only)
  for (const [token, id] of Object.entries(tokenizerJson.model.vocab)) {
    if (special.has(id)) continue;
    const bytes = [...token].map(ch => decoder.get(ch));
    if (bytes.every(b => b !== undefined)) tokenBytes.set(id, bytes);
  }
  const eot = (tokenizerJson.added_tokens ?? []).find(t => t.content === '<|endoftext|>')?.id;
  const forbidden = [0, 1, 2, 3].map(state => {
    const ids = [];
    for (const [id, bytes] of tokenBytes) if (run(state, bytes) < 0) ids.push(id);
    if (state !== 0 && eot !== undefined) ids.push(eot);
    return ids;
  });
  // State after the ordinary tokens generated so far (special tokens have no bytes).
  const stateOf = ids => {
    let state = 0;
    for (const id of ids) {
      const bytes = tokenBytes.get(Number(id));
      if (bytes) state = Math.max(0, run(state, bytes));
    }
    return state;
  };
  return { forbidden, stateOf };
}

const kanaCache = new WeakMap(); // pipeline -> { prompt, processor }

// LogitsProcessorClass: transformers.js's LogitsProcessor base class.
export async function recognizeKana(asr, audio, tokenizerJson, LogitsProcessorClass) {
  if (!kanaCache.has(asr)) {
    const tok = asr.tokenizer;
    const special = t => tok.encode(t, { add_special_tokens: false })[0];
    const { forbidden, stateOf } = hiraganaConstraint(tokenizerJson);
    class HiraganaOnly extends LogitsProcessorClass {
      _call(inputIds, logits) {
        for (let i = 0; i < inputIds.length; i++) {
          const data = logits[i].data;
          for (const id of forbidden[stateOf(inputIds[i])]) data[id] = -Infinity;
        }
        return logits;
      }
    }
    kanaCache.set(asr, {
      prompt: [[special('<|startoftranscript|>'), special('<|ja|>'),
        special('<|transcribe|>'), special('<|notimestamps|>')]],
      processor: new HiraganaOnly(),
    });
  }
  const { prompt, processor } = kanaCache.get(asr);
  const inputs = await asr.processor(audio);
  const ids = (await asr.model.generate({
    ...inputs, decoder_input_ids: prompt, max_new_tokens: 24, logits_processor: [processor],
  })).tolist()[0].map(Number);
  return asr.tokenizer.decode(ids.slice(prompt[0].length), { skip_special_tokens: true });
}

// ---- Japanese readings: hiragana CTC model ---------------------------------
//
// The bundled hiragana model (models/distilhubert-hiragana) emits kana per
// 20 ms frame; there is no language model to "fix" what was said. Returns the
// best few distinct readings so the user can pick (they come from the audio
// alone). Returns raw candidate strings, best first; the caller normalises and
// de-duplicates them.
// model: a transformers.js HubertForCTC; vocab: kana_vocab.json; TensorClass:
// transformers.js Tensor.
export async function recognizeCtc(model, vocab, audio, TensorClass, topK = 3) {
  const input = new TensorClass('float32', audio, [1, audio.length]);
  const { logits } = await model({ input_values: input });
  const [, frames, size] = logits.dims;
  const toText = ids => ids.map(id => vocab.tokens[id]).join('');
  // First choice: greedy (best token per frame). On real readings it beat the
  // beam's top hypothesis, which tends to append a trailing ー; the beam
  // supplies the alternatives.
  const greedy = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    for (let v = 1; v < size; v++) if (logits.data[t * size + v] > logits.data[t * size + best]) best = v;
    if (best !== vocab.blank && best !== prev) greedy.push(best);
    prev = best;
  }
  const beam = ctcBeamSearch(logits.data, frames, size, { blank: vocab.blank, topK: topK + 2 });
  // Alternatives under 5% of the top hypothesis are noise (ねんん, かこうう).
  const floor = (beam[0]?.logProb ?? 0) + Math.log(0.05);
  return [toText(greedy), ...beam.filter(h => h.logProb >= floor).map(h => toText(h.ids))];
}
