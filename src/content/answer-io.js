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
  // passes through WanaKana unchanged. focus: false leaves focus alone (on
  // touch screens focusing the box pops up the on-screen keyboard).
  function fill(text, { focus = true } = {}) {
    const el = input();
    // WaniKani locks the input with enabled="false" while an answer is graded.
    if (!el || el.disabled || el.getAttribute('enabled') === 'false') return false;
    nativeValueSetter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (focus) el.focus();
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

  // The answer box's current text (the user's own answer, never the question),
  // used to tell whether they've typed over a recognised answer.
  function value() {
    return input()?.value ?? '';
  }

  // Whether the current answer has been graded: WaniKani sets correct="true" /
  // "false" on the input container and removes it when the next question
  // loads (confirmed on the live page 2026-10-04).
  function isGraded() {
    return !!document.querySelector(SELECTORS.inputContainer)?.hasAttribute('correct');
  }

  // Whether the graded answer was marked correct (correct="true").
  function isCorrect() {
    return document.querySelector(SELECTORS.inputContainer)?.getAttribute('correct') === 'true';
  }

  // Whether el is the answer box, and taking focus away from it (on touch
  // screens, a focused box means the on-screen keyboard covers the page).
  const isInput = el => !!el && el === input();
  function blur() {
    const el = input();
    if (el && document.activeElement === el) el.blur();
  }

  WKV.answerIO = { isPresent, fill, value, submit: pressSubmit, advance: pressSubmit, isGraded, isCorrect, isInput, blur };
})(globalThis.WKV = globalThis.WKV || {});
