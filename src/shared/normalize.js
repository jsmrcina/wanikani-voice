// Turns raw recognizer output into an answer string.
//
// Normalisation only: never corrects toward a "right" answer, never uses
// anything from the page except the mode ('en' | 'ja-kana').
//
// Loaded as a classic script (background page, unit-test page), so it attaches
// to a shared namespace instead of using ES module exports.
(function (WKV) {
  'use strict';

  // ---- English -------------------------------------------------------------

  const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
  };
  const SCALES = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
  const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'hm', 'hmm', 'mm', 'mhm',
    'er', 'erm', 'ah', 'eh', 'huh']);
  const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten'];

  // House rule (2026-10-04): numbers up to ten are written as words, larger
  // numbers as numerals. "Ten" stays a word because 十's WaniKani meaning is
  // "ten".
  function renderNumber(n) {
    return n <= 10 && Number.isInteger(n) && n >= 0 ? DIGIT_WORDS[n] : String(n);
  }

  function isNumberToken(tok) {
    return tok in SMALL || tok in SCALES || /^\d+(\.\d+)?$/.test(tok);
  }

  // Parses a run of number tokens ("twenty one", "5 thousand", "100") into a
  // value. Returns null for runs that aren't a single well-formed number, e.g.
  // "one two", which is left untouched rather than guessed at.
  function parseRun(tokens) {
    let total = 0;
    let current = 0;
    let lastWasSmall = false;
    for (const tok of tokens) {
      if (tok in SCALES) {
        const scale = SCALES[tok];
        if (scale === 100) {
          current = (current || 1) * 100;
        } else {
          total += (current || 1) * scale;
          current = 0;
        }
        lastWasSmall = false;
        continue;
      }
      const value = tok in SMALL ? SMALL[tok] : Number(tok);
      if (lastWasSmall) {
        // "twenty one" is fine (tens then units); "one two" or "21 5" is not.
        const prev = current % 100;
        const okCompound = prev >= 20 && prev % 10 === 0 && value < 10;
        if (!okCompound) return null;
      }
      current += value;
      lastWasSmall = true;
    }
    return total + current;
  }

  function normalizeNumbers(words) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      if (!isNumberToken(words[i])) {
        out.push(words[i]);
        i += 1;
        continue;
      }
      // Greedy run; "and" is allowed inside it ("one hundred and five").
      let j = i;
      const run = [];
      while (j < words.length) {
        if (isNumberToken(words[j])) {
          run.push(words[j]);
          j += 1;
        } else if (words[j] === 'and' && run.length && j + 1 < words.length &&
                   isNumberToken(words[j + 1]) && run.some(t => t in SCALES)) {
          j += 1;
        } else {
          break;
        }
      }
      const value = parseRun(run);
      if (value === null) {
        out.push(...run.map(t => (/^\d+$/.test(t) ? renderNumber(Number(t)) : t)));
      } else {
        out.push(renderNumber(value));
      }
      i = j;
    }
    return out;
  }

  function normalizeEnglish(raw) {
    let s = String(raw).normalize('NFKC').toLowerCase();
    if (/[぀-ヿ一-鿿]/.test(s)) {
      return { ok: false, reason: 'Heard Japanese, expected English' };
    }
    s = s
      .replace(/[‘’]/g, "'")
      .replace(/[‐-―]/g, '-')
      .replace(/(\d),(?=\d{3}\b)/g, '$1')        // 1,000 -> 1000
      .replace(/(\d)\.(?=\d)/g, '$1\u0000')      // protect decimals
      .replace(/(\w)-(?=\w)/g, (m, c) => `${c} `) // twenty-one -> twenty one
      .replace(/[^a-z0-9'\u0000 ]+/g, ' ')
      .replace(/\u0000/g, '.')
      .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')    // stray quotes, keep "one's"
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return { ok: false, reason: "Didn't catch that" };
    // Hesitations aren't answers ("um", "uh, hmm").
    if (s.split(' ').every(w => FILLERS.has(w))) return { ok: false, reason: "Didn't catch that", hesitation: true };
    const words = normalizeNumbers(s.split(' '));
    const homophones = homophonesOf(words);
    return homophones.length ? { ok: true, text: words.join(' '), homophones } : { ok: true, text: words.join(' ') };
  }

  // Short words that sound like others (to/two, a/eh, for/four) but are
  // only ever grammar inside a phrase: "to pour" never means "two pour".
  const PHRASE_GLUE = new Set(['a', 'an', 'the', 'to', 'too', 'two', 'for', 'four', 'of', 'in', 'on',
    'at', 'by', 'be', 'or', 'and', 'so', 'i', 'one', 'no', 'not', 'our', 'are', 'its', "it's", 'we',
    'you', 'your', 'there', 'their', 'is', 'as', 'up', 'out', 'off', 'with', 'from', 'into', 'some']);

  // Spellings that sound the same as what was heard (eye for I, tail for
  // tale), from src/shared/homophones.js: the recogniser can't tell them
  // apart, and the question may not be used to decide (F4), so they are
  // offered as choices. One word changed at a time; in a phrase, not the
  // grammatical glue.
  function homophonesOf(words) {
    const table = WKV.homophones ?? {};
    const out = [];
    words.forEach((w, i) => {
      if (words.length > 1 && PHRASE_GLUE.has(w)) return;
      for (const alt of table[w] ?? []) out.push([...words.slice(0, i), alt, ...words.slice(i + 1)].join(' '));
    });
    return out;
  }

  // ---- Japanese ------------------------------------------------------------

  function katakanaToHiragana(s) {
    return s.replace(/[ァ-ヶヽヾ]/g,
      ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

  const KANA_PUNCT = /[\s　、。，．,.!?！？「」『』・…〜~'"-]/g;
  const HIRAGANA_ONLY = /^[ぁ-ゖゝゞ]+$/;

  // Rows by vowel, for spelling out ー the way readings are written.
  const VOWEL_OF = {};
  for (const [vowel, row] of Object.entries({
    a: 'あかさたなはまやらわがざだばぱぁゃ', i: 'いきしちにひみりぎじぢびぴぃ',
    u: 'うくすつぬふむゆるぐずづぶぷぅゅ', e: 'えけせてねへめれげぜでべぺぇ',
    o: 'おこそとのほもよろをごぞどぼぽぉょ',
  })) for (const ch of row) VOWEL_OF[ch] = vowel;
  const LONG = { a: 'あ', i: 'い', u: 'う', e: 'い', o: 'う' };

  // The hiragana model writes long vowels phonetically (きょー); readings are
  // spelled out (きょう). Convention, not correction: o- and u-rows lengthen
  // with う, e-row with い (the usual on'yomi spellings), a- and i-rows repeat
  // the vowel. おお/ええ spellings (おおきい) aren't recoverable from sound.
  function expandLongVowels(s) {
    let out = '';
    for (const ch of s) {
      if (ch === 'ー') {
        const vowel = VOWEL_OF[out[out.length - 1]];
        if (!vowel) return null; // ー after ん, っ or at the start: not a reading
        out += LONG[vowel];
      } else {
        out += ch;
      }
    }
    return out;
  }

  // Small ゃゅょ only ever follow an i-row kana (きゃ, じゅ, ぴょ).
  const YOON_BASE = 'きしちにひみりぎじぢびぴ';
  const SMALL_KANA = 'ぁぃぅぇぉゃゅょゎ';

  // Kana sequences no word can contain: a small ゃゅょ after anything but an
  // i-row kana (ゆゅ, んょ), a small kana after another small kana, ん, っ or
  // ー, and っ before a vowel, ん, っ or a small kana. っ at the end is
  // possible: some kanji readings end in it (合 がっ). Checked on the
  // spelling alone, never against the question; no reading among WaniKani's
  // 6,924 fails it (2026-10-20).
  function impossibleKana(s) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const prev = s[i - 1];
      if ('ゃゅょ'.includes(ch) && !YOON_BASE.includes(prev)) return true;
      if (SMALL_KANA.includes(ch) && (!prev || SMALL_KANA.includes(prev) || 'んっー'.includes(prev))) return true;
      if (ch === 'っ' && ('あいうえおんっー'.includes(s[i + 1]) || SMALL_KANA.includes(s[i + 1]))) return true;
    }
    return false;
  }

  // ず/づ and じ/ぢ sound the same in modern Japanese, so the model can't
  // tell which was meant (つづく, ちぢむ, はなぢ): each spelling with one of
  // them swapped. Convention, not correction: the swap is the same for every
  // question.
  const SAME_SOUND = { ず: 'づ', づ: 'ず', じ: 'ぢ', ぢ: 'じ' };
  function sameSoundSpellings(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (SAME_SOUND[s[i]]) out.push(s.slice(0, i) + SAME_SOUND[s[i]] + s.slice(i + 1));
    }
    return out;
  }

  function normalizeKana(raw) {
    const folded = katakanaToHiragana(String(raw).normalize('NFKC')).replace(KANA_PUNCT, '');
    const s = expandLongVowels(folded);
    if (s === null) return { ok: false, reason: 'Expected kana only' };
    if (!s) return { ok: false, reason: "Didn't catch that" };
    if (/[一-鿿㐀-䶿]/.test(s)) {
      // A kanji's reading is ambiguous; never guess which one was said.
      return { ok: false, reason: 'Got kanji, not kana — try again' };
    }
    if (!HIRAGANA_ONLY.test(s)) return { ok: false, reason: 'Expected kana only' };
    // No reading starts with ん, っ or a small kana: that's a hum or a cough.
    if (/^[んっぁぃぅぇぉゃゅょゎ]/.test(s)) return { ok: false, reason: "Didn't catch that" };
    if (impossibleKana(s)) return { ok: false, reason: 'Not a possible reading' };
    const result = { ok: true, text: s };
    const spellings = sameSoundSpellings(s);
    if (spellings.length) result.spellings = spellings;
    // A few WaniKani readings really do contain ー (びーだま, ビー玉), so when
    // ー was heard, the form that keeps it is offered as an alternative.
    if (folded !== s && /^[\u3041-\u3096\u309d\u309e][\u3041-\u3096\u309d\u309eー]*$/.test(folded)) {
      result.alternates = [folded];
    }
    return result;
  }

  function normalizeAnswer(raw, mode) {
    if (mode === 'en') return normalizeEnglish(raw);
    if (mode === 'ja-kana') return normalizeKana(raw);
    return { ok: false, reason: `Unknown mode ${mode}` };
  }

  // ---- Choices -------------------------------------------------------------

  // Turns a recogniser's candidates (best first) into the answers offered:
  // each normalised, the valid and distinct ones kept, up to `max`. Order:
  // the best answer, the other candidates, words that sound like the best
  // answer, then the alternate spellings (with ー). Those spellings come
  // last: only a handful of readings really contain ー (びーだま), and as
  // choice 2 they pushed real alternatives out (400 personal readings,
  // 2026-10-16: right reading offered 265 -> 270; びーだま, かんびーる and
  // ぺーじ no worse). Homophones go after what the model itself heard:
  // offered straight after the best answer they pushed better candidates
  // out (Whisper, 300 personal recordings, 2026-10-16: right answer offered
  // 281 -> 276; after the candidates 285 -> 286). `exclude`: answers the
  // user already rejected on this question by recording again; they are
  // left out unless nothing else is left (then `repeated` is set).
  // Same-sound spellings (ず/づ, じ/ぢ) of the best answer go with the
  // homophones (`spellingsEarly`: straight after the best answer instead).
  // `dictionary`: a Set of every WaniKani answer for this mode (the user's
  // imported dictionary, never just this question's); answers in it move
  // ahead of answers that aren't, otherwise in the same order. Shared by
  // the background page and tools/eval-asr.mjs. Returns
  // { ok, text, choices, repeated? } or the first candidate's rejection
  // { ok: false, reason }.
  function buildChoices(candidates, mode, { exclude = [], max = 3, homophones = true, dictionary = null, spellingsEarly = false } = {}) {
    const normalized = candidates.map(c => normalizeAnswer(c, mode));
    // The likeliest reading of the clip is a hesitation: that's no answer,
    // whatever a less likely alternative made of it ("um" -> "um in", seen
    // with the fine-tuned Moonshine 2026-10-16).
    if (normalized[0]?.hesitation) return normalized[0];
    const valid = normalized.filter(n => n.ok);
    const spellings = valid[0]?.spellings ?? [];
    let ordered = [...new Set([
      ...(valid[0] ? [valid[0].text] : []),
      ...(spellingsEarly ? spellings : []),
      ...valid.slice(1).map(n => n.text),
      ...(homophones ? valid[0]?.homophones ?? [] : []),
      ...(spellingsEarly ? [] : spellings),
      ...valid.flatMap(n => n.alternates ?? []),
    ])];
    if (dictionary?.size) ordered = [...ordered.filter(t => dictionary.has(t)), ...ordered.filter(t => !dictionary.has(t))];
    if (!ordered.length) return normalized[0] ?? { ok: false, reason: "Didn't catch that" };
    const rejected = new Set(exclude);
    const fresh = ordered.filter(t => !rejected.has(t));
    // Heard only what was already rejected: offer it again rather than
    // nothing, and say so.
    if (!fresh.length) return { ok: true, text: ordered[0], choices: ordered.slice(0, max), repeated: true };
    const choices = fresh.slice(0, max);
    return { ok: true, text: choices[0], choices };
  }

  WKV.normalize = { normalizeAnswer, normalizeEnglish, normalizeKana, katakanaToHiragana, buildChoices };
})(globalThis.WKV = globalThis.WKV || {});
