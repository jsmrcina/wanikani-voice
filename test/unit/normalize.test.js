// Runs in a plain page (test/unit/index.html); results land in #results as JSON.
(function () {
  'use strict';
  const { normalizeAnswer } = WKV.normalize;
  const cases = [
    // [raw, mode, expected text | null for "rejected"]
    // English: tidy-up only
    ['Fire.', 'en', 'fire'],
    ['  Big   Dog! ', 'en', 'big dog'],
    ["One's own", 'en', "one's own"],
    ['"mouth"', 'en', 'mouth'],
    ['', 'en', null],
    ['...', 'en', null],
    ['じん', 'en', null],
    // English: numbers up to ten as words, above as numerals
    ['4', 'en', 'four'],
    ['four', 'en', 'four'],
    ['10', 'en', 'ten'],
    ['ten', 'en', 'ten'],
    ['11', 'en', '11'],
    ['eleven', 'en', '11'],
    ['twenty', 'en', '20'],
    ['twenty-one', 'en', '21'],
    ['twenty one', 'en', '21'],
    ['one hundred and five', 'en', '105'],
    ['ten thousand', 'en', '10000'],
    ['10,000', 'en', '10000'],
    ['5 thousand', 'en', '5000'],
    ['1 person', 'en', 'one person'],
    ['three people', 'en', 'three people'],
    ['one two', 'en', 'one two'],
    ['Day 4', 'en', 'day four'],
    ['someone', 'en', 'someone'],
    ['Um.', 'en', null],
    ['Um, huh.', 'en', null],
    ['umbrella', 'en', 'umbrella'],
    ['no one', 'en', 'no one'],
    // Japanese: kana only, katakana folded to hiragana, kanji rejected
    ['じん', 'ja-kana', 'じん'],
    ['ジン', 'ja-kana', 'じん'],
    ['ｼﾞﾝ', 'ja-kana', 'じん'],
    ['お とな。', 'ja-kana', 'おとな'],
    ['「がっこう」', 'ja-kana', 'がっこう'],
    ['ラーメン', 'ja-kana', 'らーめん'],
    ['人', 'ja-kana', null],
    ['じん人', 'ja-kana', null],
    ['jin', 'ja-kana', null],
    ['', 'ja-kana', null],
  ];
  const failures = [];
  for (const [raw, mode, expected] of cases) {
    const got = normalizeAnswer(raw, mode);
    const ok = expected === null ? !got.ok : got.ok && got.text === expected;
    if (!ok) failures.push({ raw, mode, expected, got });
  }
  document.getElementById('results').textContent =
    JSON.stringify({ total: cases.length, failures });
})();
