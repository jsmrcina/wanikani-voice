// Writes to WaniKani's answer box and presses its submit button. Apart from
// page-reader.js, this is the only content module allowed to touch the page.
// It reads nothing about the question; it only checks whether the current
// answer has been graded yet.
(function (WKV) {
  'use strict';

  const SELECTORS = Object.freeze({
    input: '#user-response',
    submit: '.quiz-input__submit-button',
    inputContainer: '.quiz-input__input-container',
  });

  const nativeValueSetter =
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function input() {
    return document.querySelector(SELECTORS.input);
  }

  function isPresent() {
    return !!input();
  }

  // Sets the value the way a user's typing would, so WaniKani's controllers
  // (and WanaKana, on reading questions) see an ordinary input event. Kana
  // passes through WanaKana unchanged.
  function fill(text) {
    const el = input();
    // WaniKani locks the input with enabled="false" while an answer is graded.
    if (!el || el.disabled || el.getAttribute('enabled') === 'false') return false;
    nativeValueSetter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    return true;
  }

  // The submit button is what Enter triggers; clicking it is equivalent and
  // doesn't depend on WaniKani accepting synthetic key events. Once an answer
  // is graded, the same button moves on to the next question.
  function pressSubmit() {
    const button = document.querySelector(SELECTORS.submit);
    if (button) {
      button.click();
      return true;
    }
    const el = input();
    if (!el) return false;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    return true;
  }

  // Whether the current answer has been graded: WaniKani sets correct="true" /
  // "false" on the input container and removes it when the next question
  // loads (confirmed on the live page 2026-10-04).
  function isGraded() {
    return !!document.querySelector(SELECTORS.inputContainer)?.hasAttribute('correct');
  }

  WKV.answerIO = { isPresent, fill, submit: pressSubmit, advance: pressSubmit, isGraded };
})(globalThis.WKV = globalThis.WKV || {});
