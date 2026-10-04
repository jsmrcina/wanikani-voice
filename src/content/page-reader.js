// The ONLY module that reads WaniKani's question area, and it reads only the
// question *type*: which kind of subject (radical / kanji / vocabulary) and
// whether a meaning or a reading is asked for.
//
// It must never read the question itself (the characters, the item's
// meanings/readings, item info, or WaniKani's event payloads). test/policy.py
// enforces that no other content module queries the page.
(function (WKV) {
  'use strict';

  // Confirmed on the live review page 2026-10-04. The labels read e.g.
  // "Vocabulary" / "reading"; the container also carries data-question-type.
  const SELECTORS = Object.freeze({
    category: '.quiz-input__question-category',
    type: '.quiz-input__question-type',
    typeContainer: '.quiz-input__question-type-container',
  });

  const REVIEW_PATH = /^\/subjects\/review(\/|$)/;

  function isReviewPage() {
    return REVIEW_PATH.test(location.pathname);
  }

  function text(selector) {
    const el = document.querySelector(selector);
    return el ? el.textContent.trim().toLowerCase() : '';
  }

  // Returns { subject, kind, mode } or null if the type can't be determined.
  //   subject: 'radical' | 'kanji' | 'vocabulary'
  //   kind:    'meaning' | 'reading'   (a radical's "name" is a meaning)
  //   mode:    'en' | 'ja-kana'        (what the recognizer should listen for)
  function getQuestionType() {
    const category = text(SELECTORS.category);
    let subject = null;
    if (category.includes('radical')) subject = 'radical';
    else if (category.includes('kanji')) subject = 'kanji';
    else if (category.includes('vocabulary')) subject = 'vocabulary';

    let typeText = text(SELECTORS.type);
    if (!typeText) {
      const container = document.querySelector(SELECTORS.typeContainer);
      typeText = container?.getAttribute('data-question-type')?.toLowerCase() ?? '';
    }
    let kind = null;
    if (typeText.includes('reading')) kind = 'reading';
    else if (typeText.includes('meaning') || typeText.includes('name')) kind = 'meaning';

    if (!subject || !kind) return null;
    if (subject === 'radical' && kind === 'reading') return null; // not a thing
    return { subject, kind, mode: kind === 'reading' ? 'ja-kana' : 'en' };
  }

  WKV.pageReader = { isReviewPage, getQuestionType };
})(globalThis.WKV = globalThis.WKV || {});
