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
    if (s.split(' ').every(w => FILLERS.has(w))) return { ok: false, reason: "Didn't catch that" };
    return { ok: true, text: normalizeNumbers(s.split(' ')).join(' ') };
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
    return { ok: true, text: s };
  }

  function normalizeAnswer(raw, mode) {
    if (mode === 'en') return normalizeEnglish(raw);
    if (mode === 'ja-kana') return normalizeKana(raw);
    return { ok: false, reason: `Unknown mode ${mode}` };
  }

  WKV.normalize = { normalizeAnswer, normalizeEnglish, normalizeKana, katakanaToHiragana };
})(globalThis.WKV = globalThis.WKV || {});
