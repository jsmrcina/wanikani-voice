// Content-script controller: watches the review session, drives the
// listen -> transcribe -> fill (-> submit) cycle, and keeps the indicator in
// sync.
//
// What it may know about the page comes only from WKV.pageReader (question
// type) and WKV.answerIO (graded or not). WaniKani's quiz events only trigger a
// re-check: their payloads describe the subject and are never read, and their
// order isn't relied on (didAnswerQuestion fires both on grading and again on
// advancing, just before willShowNextQuestion; seen live 2026-10-04).
(function (WKV) {
  'use strict';

  const { pageReader, answerIO } = WKV;

  let settings = { ...WKV.settings.DEFAULTS };
  let active = false;
  let indicator = null;
  let observer = null;
  let state = 'off';
  let question = null;       // { subject, kind, mode } of the current question
  let lastGraded = false;
  let generation = 0;        // bumps per question; stale transcripts are dropped
  let pttHeld = false;
  let evaluateTimer = null;
  let followUpTimer = null;  // error -> ready, or auto-advance

  // ---- helpers -------------------------------------------------------------

  function keyLabel(code) {
    const named = { Shift: 'Shift', Backquote: '`', Space: 'Space', Backslash: '\\', Quote: "'",
      Semicolon: ';', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.',
      Slash: '/', Minus: '-', Equal: '=' };
    if (named[code]) return named[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return code;
  }

  function setState(next, message) {
    state = next;
    indicator.set(next, { mode: question?.mode, message });
  }

  function clearFollowUp() {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }

  // ---- state transitions ---------------------------------------------------

  function enterReady(message) {
    clearFollowUp();
    if (settings.inputMode === 'voice-activity') {
      startListening();
    } else {
      setState('ready', message ?? (settings.recognizer === 'fake'
        ? `Test mode (no mic): type below, then hold ${keyLabel(settings.pttKey)}`
        : `Hold ${keyLabel(settings.pttKey)} to answer`));
    }
  }

  function onNewQuestion(q) {
    generation += 1;
    question = q;
    pttHeld = false;
    enterReady();
  }

  function onGraded() {
    generation += 1;  // drop anything still in flight for this question
    pttHeld = false;
    clearFollowUp();
    if (settings.autoAdvance) {
      setState('waiting', 'Next question shortly…');
      followUpTimer = setTimeout(() => {
        if (active && settings.enabled && answerIO.isGraded()) answerIO.advance();
      }, settings.autoAdvanceDelayMs);
    } else {
      setState('waiting', 'Press Enter for the next question');
    }
  }

  function startListening() {
    if (!question) return;
    clearFollowUp();
    // Phase 1: no microphone yet. Phase 2 starts audio capture here.
    setState('listening', settings.recognizer === 'fake'
      ? 'Test mode: using the text typed below' : 'Listening…');
  }

  async function finishListening() {
    if (state !== 'listening' || !question) return;
    const gen = generation;
    const mode = question.mode;
    if (settings.recognizer === 'fake' && !indicator.fakeUtterance().trim()) {
      setState('error', 'Test mode has no microphone: type an answer in the field below first');
      followUpTimer = setTimeout(() => { if (gen === generation && state === 'error') enterReady(); }, 3000);
      return;
    }
    setState('processing');
    let result;
    try {
      // The whole request: a mode and the user's speech. No page content.
      result = await browser.runtime.sendMessage({
        type: 'wkv:transcribe',
        mode,
        fakeUtterance: indicator.fakeUtterance(),
      });
    } catch (err) {
      result = { ok: false, reason: `Recognizer error: ${err.message}` };
    }
    if (gen !== generation || state !== 'processing') return; // question moved on
    if (!result?.ok) {
      setState('error', result?.reason ?? "Didn't catch that");
      followUpTimer = setTimeout(() => {
        if (gen === generation && state === 'error') {
          enterReady(settings.inputMode === 'push-to-talk' ? `${result?.reason ?? ''} — hold ${keyLabel(settings.pttKey)} to retry` : undefined);
        }
      }, 2000);
      return;
    }
    if (!answerIO.fill(result.text)) {
      setState('error', "Couldn't fill the answer box");
      return;
    }
    if (settings.submitMode === 'auto-submit') {
      setState('filled', result.text);
      answerIO.submit();
    } else {
      setState('filled', `${result.text} — Enter to submit, or ${keyLabel(settings.pttKey)} to retry`);
    }
  }

  function cancelListening() {
    if (state === 'listening') enterReady();
    pttHeld = false;
  }

  // Re-derives where we are from the page. Called (debounced) on DOM changes
  // and quiz events, so it doesn't depend on any single signal being right.
  function evaluate() {
    evaluateTimer = null;
    if (!active) return;
    if (!settings.enabled) {
      if (state !== 'off') {
        generation += 1;
        clearFollowUp();
        question = null;
        setState('off', 'Paused');
      }
      return;
    }
    const q = pageReader.getQuestionType();
    if (!q || !answerIO.isPresent()) {
      if (state !== 'unsupported') {
        generation += 1;
        clearFollowUp();
        question = null;
        setState('unsupported', "Can't tell what kind of question this is");
      }
      return;
    }
    const graded = answerIO.isGraded();
    const unGraded = lastGraded && !graded;
    lastGraded = graded;
    if (graded) {
      if (state !== 'waiting') onGraded();
      return;
    }
    const typeChanged = !question || q.subject !== question.subject || q.kind !== question.kind;
    if (unGraded || typeChanged || state === 'waiting') onNewQuestion(q);
  }

  function scheduleEvaluate() {
    if (evaluateTimer === null) evaluateTimer = setTimeout(evaluate, 30);
  }

  // ---- input ---------------------------------------------------------------

  // Shorter presses are treated as accidental taps, not speech.
  const MIN_HOLD_MS = 200;
  let pttDownAt = 0;

  // 'Shift' (the default) means either Shift key; anything else is a
  // KeyboardEvent.code such as 'Backquote' or 'KeyJ'.
  function pttIsModifier() {
    return settings.pttKey === 'Shift';
  }

  function isPttEvent(e) {
    const match = pttIsModifier() ? e.key === 'Shift' : e.code === settings.pttKey;
    return match && !e.ctrlKey && !e.altKey && !e.metaKey && !indicator.ownsEvent(e);
  }

  // Swallow a non-modifier PTT key so it isn't typed into the answer box or
  // seen as a WaniKani hotkey. Shift is left alone: it types nothing itself,
  // and other code may track its state.
  function swallow(e) {
    if (pttIsModifier()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (!settings.enabled) return;
    if (!isPttEvent(e)) {
      // Another key while holding PTT (Shift+A for a capital, a shortcut):
      // the user is typing, not talking.
      if (pttHeld && !indicator.ownsEvent(e)) cancelListening();
      return;
    }
    swallow(e);
    if (e.repeat || pttHeld) return;
    if (['ready', 'filled', 'error', 'listening'].includes(state)) {
      pttHeld = true;
      pttDownAt = performance.now();
      if (state !== 'listening') startListening();
    }
  }

  function onKeyUp(e) {
    if (!settings.enabled || !isPttEvent(e)) return;
    swallow(e);
    if (!pttHeld) return;
    if (performance.now() - pttDownAt < MIN_HOLD_MS) {
      cancelListening();
      return;
    }
    pttHeld = false;
    finishListening();
  }

  function onKeyPress(e) {
    if (settings.enabled && isPttEvent(e)) swallow(e);
  }

  // Enter in the indicator's test field = "I just said this".
  function onFakeUtterance() {
    if (['ready', 'filled', 'error'].includes(state)) startListening();
    finishListening();
  }

  function onToggle() {
    WKV.settings.save({ enabled: !settings.enabled });
  }

  // Never keep listening into a tab the user has left.
  function onHidden() {
    if (document.hidden && pttHeld) cancelListening();
  }
  function onBlur() {
    if (pttHeld) cancelListening();
  }

  // ---- lifecycle -----------------------------------------------------------

  function activate() {
    active = true;
    indicator = WKV.indicator.create({ onToggle, onFakeUtterance });
    indicator.setDevMode(settings.recognizer === 'fake');
    state = 'off';
    question = null;
    lastGraded = false;
    setState(settings.enabled ? 'unsupported' : 'off');
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keypress', onKeyPress, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('didAnswerQuestion', scheduleEvaluate);
    window.addEventListener('willShowNextQuestion', scheduleEvaluate);
    observer = new MutationObserver(records => {
      if (records.some(r => !indicator.ownsNode(r.target))) scheduleEvaluate();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    scheduleEvaluate();
  }

  function deactivate() {
    active = false;
    generation += 1;
    clearFollowUp();
    observer?.disconnect();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('keypress', onKeyPress, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('didAnswerQuestion', scheduleEvaluate);
    window.removeEventListener('willShowNextQuestion', scheduleEvaluate);
    indicator?.destroy();
    indicator = null;
  }

  // WaniKani navigates with Turbo, so the review page can be reached without a
  // full page load: re-check on every visit.
  function checkPage() {
    const want = pageReader.isReviewPage();
    if (want && !active) activate();
    else if (!want && active) deactivate();
  }

  WKV.settings.onChange(next => {
    const wasFake = settings.recognizer === 'fake';
    settings = next;
    if (!active) return;
    if (wasFake !== (next.recognizer === 'fake')) indicator.setDevMode(next.recognizer === 'fake');
    // Re-enter the current question under the new settings.
    question = null;
    if (next.enabled && state === 'off') state = 'unsupported';
    scheduleEvaluate();
  });

  WKV.settings.load().then(loaded => {
    settings = loaded;
    checkPage();
    window.addEventListener('turbo:load', checkPage);
    window.addEventListener('popstate', checkPage);
  });
})(globalThis.WKV = globalThis.WKV || {});
