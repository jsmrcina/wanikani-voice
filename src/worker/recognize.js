// Speech decoding shared by the extension's worker and tools/eval-asr.mjs,
// so offline evaluation measures exactly what the extension does.
import { ctcBeamSearch, ctcScore, logSoftmax } from './ctc.js';

// A fixed decoder prompt nudges Whisper toward short dictionary-style answers
// ("Hand." rather than "And", "Sun." rather than "Son."). It is the same for
// every question and never contains anything from the page. Its words are
// deliberately absent from the evaluation set; measured 2026-10-04 on real
// recordings: 21/25 -> 22/25 raw, 18/25 -> 20/25 through a noise gate.
export const PROMPT = ' Rain. Old man. Dog. To run. Heart. Seven. Leaf. Blue.';
const promptCache = new WeakMap(); // pipeline -> decoder_input_ids

const isWhisper = asr => asr.model.config.model_type === 'whisper';

// Decoder start: Whisper gets the fixed prompt above; Moonshine (no prompt
// support) starts from its decoder start token alone.
function decoderPrompt(asr) {
  if (!promptCache.has(asr) && !isWhisper(asr)) {
    const start = asr.model.generation_config?.decoder_start_token_id ?? asr.model.config.decoder_start_token_id ?? 1;
    promptCache.set(asr, [[start]]);
  }
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

// At a step, tokens under this share of the chosen token's probability are noise.
const MIN_RELATIVE = 0.05;
// Alternatives stop being decoded once they have taken this long, so a long
// phrase on a slow device can't hold the answer up.
const ALTERNATIVES_BUDGET_MS = 1000;

// Returns candidate transcripts, best first: the greedy decode and up to
// `alternatives` more, ordered by their whole-answer probability.
// transformers.js 4.3 has no real beam search (generate() keeps one token per
// step) and returns no scores, so a logits processor records every step's
// log-probabilities, and the audio is encoded once and reused for every
// decode. An alternative branches off the greedy decode at any step where
// another ordinary text token was close (hand / and at the start, tale / tail
// later in a phrase) and is completed greedily; the likeliest branch points
// (by the probability of the path up to them) are decoded.
// Measured 2026-10-16 on 300 personal recordings, against branching only at
// the first token (2 alternatives, greedy first): Moonshine first choice
// 227 -> 235, offered 258 -> 267; Whisper 246 -> 248, 281 -> 285; the
// 25-clip benchmark unchanged or better. ~+100 ms per answer in Node.
// LogitsProcessorClass: transformers.js's LogitsProcessor (needed only for
// alternatives).
export async function recognize(asr, audio, { alternatives = 0, LogitsProcessorClass = null } = {}) {
  const inputs = await asr.processor(audio);
  const prompt = decoderPrompt(asr);
  const promptLen = prompt[0].length;
  // Whisper takes log-mel features; Moonshine takes the raw audio.
  const inputName = 'input_features' in inputs ? 'input_features' : 'input_values';
  // generate() returns the prompt too; keep only what follows it.
  const textOf = ids => asr.tokenizer.decode(ids.slice(promptLen), { skip_special_tokens: true });
  // Moonshine often ends before its first word on short clips (an empty
  // answer); Silero VAD has already found speech, so it must say something
  // (min_new_tokens below).
  // Moonshine can also keep repeating itself to the token limit, so its
  // limit follows the clip's length (6.5 tokens per second, Moonshine's own
  // guidance; at least 8 for a short clip).
  const lengthLimits = isWhisper(asr) ? { max_new_tokens: 24 } : {
    min_new_tokens: 1,
    max_new_tokens: Math.min(24, Math.max(8, Math.ceil((audio.length / 16000) * 6.5))),
  };
  const generate = async (decoderIds, extra) =>
    (await asr.model.generate({ ...extra, decoder_input_ids: decoderIds, ...lengthLimits })).tolist()[0].map(Number);

  if (!alternatives || !LogitsProcessorClass) return tidy(asr, [textOf(await generate(prompt, inputs))]);

  // Encode once and reuse it for every decode: the encoder is most of the
  // cost (~1.3 s of ~1.6 s in Firefox's single-threaded WASM). Two
  // transformers.js 4.3 internals are involved: the helper that runs the
  // encoder, and generate() keeping only inputs listed in forward_params,
  // which silently drops encoder_outputs unless it's added (measured: a decode
  // with it 50 ms, without it 325 ms, in Node). If either internal changes,
  // decoding still works, just re-encoding each time.
  let shared = inputs;
  const prepare = asr.model._prepare_encoder_decoder_kwargs_for_generation;
  if (Array.isArray(asr.model.forward_params) && !asr.model.forward_params.includes('encoder_outputs')) {
    asr.model.forward_params = [...asr.model.forward_params, 'encoder_outputs'];
  }
  if (typeof prepare === 'function') {
    const prepared = await prepare.call(asr.model, {
      inputs_tensor: inputs[inputName],
      model_inputs: { [inputName]: inputs[inputName] },
      model_input_name: inputName,
      generation_config: asr.model.generation_config,
    });
    if (prepared?.encoder_outputs) shared = { ...inputs, encoder_outputs: prepared.encoder_outputs };
  }

  // Records each decoding step's log-probabilities, keyed by how many
  // tokens came before it, so a finished decode can be scored token by token.
  class RecordSteps extends LogitsProcessorClass {
    constructor() { super(); this.steps = new Map(); }
    _call(ids, logits) {
      if (!this.steps.has(ids[0].length)) this.steps.set(ids[0].length, logSoftmax1(logits[0].data));
      return logits;
    }
  }
  // decode(prefix) -> { ids (whole sequence), steps (prefix length -> log-probs) }
  const decode = async prefix => {
    const rec = new RecordSteps();
    const ids = await generate([prefix], { ...shared, logits_processor: [rec] });
    return { ids, steps: rec.steps };
  };
  const isText = id => /[\p{L}\p{N}]/u.test(asr.tokenizer.decode([id], { skip_special_tokens: true }));

  const best = await decode(prompt[0]);
  if (best.ids.length <= promptLen || !best.steps.size) return tidy(asr, [textOf(best.ids)]);
  // Log-probability of each token of a decode, from the first decode's steps
  // up to `from` and the decode's own steps after.
  const tokenScores = (run, parent = null, from = Infinity) => run.ids.slice(promptLen).map((id, i) => {
    const at = promptLen + i;
    const steps = at < from ? parent?.steps ?? run.steps : run.steps;
    return steps.get(at)?.[id] ?? 0;
  });
  const sum = xs => xs.reduce((a, b) => a + b, 0);

  // Branch points: at each step of the best decode, the next most likely
  // ordinary text tokens within MIN_RELATIVE of the chosen one.
  const bestScores = tokenScores(best);
  const branches = [];
  for (let at = promptLen; at < best.ids.length; at++) {
    const logp = best.steps.get(at);
    if (!logp) break;
    const chosen = best.ids[at];
    const floor = logp[chosen] + Math.log(MIN_RELATIVE);
    const prefixScore = sum(bestScores.slice(0, at - promptLen));
    for (let id = 0; id < logp.length; id++) {
      if (id !== chosen && logp[id] >= floor && isText(id)) {
        branches.push({ at, id, path: prefixScore + logp[id] });
      }
    }
  }
  branches.sort((x, y) => y.path - x.path);
  const runs = [{ ids: best.ids, score: sum(bestScores) }];
  const deadline = performance.now() + ALTERNATIVES_BUDGET_MS;
  for (const b of branches.slice(0, alternatives)) {
    if (performance.now() > deadline) break;
    const run = await decode([...best.ids.slice(0, b.at), b.id]);
    // Tokens before the branch point were scored in the best decode.
    const scores = tokenScores(run, best, b.at);
    scores[b.at - promptLen] = best.steps.get(b.at)[b.id];
    runs.push({ ids: run.ids, score: sum(scores) });
  }
  runs.sort((x, y) => y.score - x.score);
  return tidy(asr, runs.map(r => textOf(r.ids)));
}

function logSoftmax1(data) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  let total = 0;
  for (let i = 0; i < data.length; i++) total += Math.exp(data[i] - max);
  const lse = max + Math.log(total);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] - lse;
  return out;
}

// Moonshine tends to repeat a short answer: "king king", "21 21", "north
// country north country north country", "barbarbar", "barbar barbar".
// Collapse a phrase repeated back to back, comparing without spaces and
// punctuation. Two copies must be separated ("king king"): run together
// they're usually a real word (murmur, tutu). Hyphens count as letters, so
// "so-so" stays. A WaniKani meaning is otherwise never the same words over
// again. Measured on real recordings 2026-10-06: moonshine-base 16/25 ->
// 20/25 first choice; the 3+ and unseparated cases were seen in use.
const SEPARATOR = /[\s,.!?]/u;
export function collapseRepeats(text) {
  const trimmed = text.trim();
  const chars = [...trimmed];
  // Positions (in chars) of the letters, separators left out.
  const letters = [];
  chars.forEach((c, i) => { if (!SEPARATOR.test(c)) letters.push(i); });
  const core = letters.map(i => chars[i].toLowerCase()).join('');
  const n = letters.length;
  for (let len = 1; len <= n / 2; len++) {
    const copies = n / len;
    if (!Number.isInteger(copies) || core !== core.slice(0, len).repeat(copies)) continue;
    const separated = SEPARATOR.test(chars[letters[len - 1] + 1] ?? '');
    if (copies === 2 && !separated) continue;
    return chars.slice(0, letters[len - 1] + 1).join('');
  }
  return text;
}

function tidy(asr, texts) {
  if (isWhisper(asr)) return texts;
  return texts.map(collapseRepeats);
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

// The clip is also heard at these speeds, and each alternative is scored by
// how well it fits all of them (mean CTC log-probability): a reading that
// only fits one tempo is likelier to be noise. Measured 2026-10-16 on 400
// personal recordings (generic model): right reading offered 253 -> 265,
// first choice unchanged (163); the 31-reading benchmark unchanged (13/13).
// Ranking the first choice by this score too gained 26 first choices on the
// personal set but lost 3 of 13 on the benchmark, mostly by adding long
// vowels (か -> かあ); the personal list over-samples long vowels, so greedy
// stays first. Generating spelling variants (よ -> りょ, っ, long vowels,
// any one-kana edit) and scoring them the same way added nothing: the right
// reading usually scores far below what was heard (りょこう 24 nats under よこー).
export const CTC_SPEEDS = [1, 0.9, 1.1];

// Linear-interpolation resampling: rate > 1 plays faster (shorter clip).
export function changeSpeed(audio, rate) {
  if (rate === 1) return audio;
  const n = Math.floor((audio.length - 1) / rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * rate;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = audio[j] * (1 - f) + audio[j + 1] * f;
  }
  return out;
}

export async function recognizeCtc(model, vocab, audio, TensorClass, topK = 3, speeds = CTC_SPEEDS) {
  const heard = [];
  for (const rate of speeds) {
    const clip = changeSpeed(audio, rate);
    const { logits } = await model({ input_values: new TensorClass('float32', clip, [1, clip.length]) });
    const [, frames, size] = logits.dims;
    heard.push({ frames, size, logp: logSoftmax(logits.data, frames, size) });
  }
  const [{ frames, size, logp }] = heard;
  const toText = ids => ids.map(id => vocab.tokens[id]).join('');
  // First choice: greedy (best token per frame) at normal speed. On real
  // readings it beat the beam's top hypothesis, which tends to append a
  // trailing ー; the beam supplies the alternatives.
  const greedy = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    for (let v = 1; v < size; v++) if (logp[t * size + v] > logp[t * size + best]) best = v;
    if (best !== vocab.blank && best !== prev) greedy.push(best);
    prev = best;
  }
  const beam = ctcBeamSearch(logp, frames, size, { blank: vocab.blank, topK: topK + 2 });
  const score = ids => heard.reduce((sum, h) => sum + ctcScore(h.logp, h.frames, h.size, ids, vocab.blank), 0) / heard.length;
  const scored = [greedy, ...beam.map(h => h.ids)]
    .map(ids => ({ ids, score: score(ids) }))
    .sort((a, b) => b.score - a.score);
  // Alternatives under 5% of the best are noise (ねんん, かこうう).
  const floor = (scored[0]?.score ?? 0) + Math.log(0.05);
  return [toText(greedy), ...scored.filter(h => h.score >= floor).map(h => toText(h.ids))];
}
