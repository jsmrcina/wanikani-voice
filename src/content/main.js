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
  let mic = null;
  let port = null;           // session channel to the background page
  let state = 'off';
  let question = null;       // { subject, kind, mode } of the current question
  let lastGraded = false;
  let generation = 0;        // bumps per question; stale transcripts are dropped
  let listenToken = 0;       // bumps per listening attempt
  let pttHeld = false;
  let evaluateTimer = null;
  let followUpTimer = null;  // error -> ready, or auto-advance
  let choices = [];          // readings offered for the current answer
  let chosen = 0;

  // What the background can recognise: mode -> model name (null = not yet),
  // and each model's loading state.
  let modeModels = null;
  const modelStatus = new Map();

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

  const isFake = () => settings.recognizer === 'fake';
  const handsFree = () => settings.inputMode === 'voice-activity';

  function setState(next, message) {
    state = next;
    indicator.set(next, { mode: question?.mode, message });
    if (next !== 'filled' && choices.length) {
      choices = [];
      indicator.setChoices([]);
    }
  }

  function choicesMessage() {
    const what = question?.mode === 'ja-kana' ? 'reading' : 'answer';
    return `Press 1–${choices.length} for another ${what}, Enter to submit`;
  }

  // Swaps the filled answer for another one the recogniser offered.
  function pick(i) {
    if (state !== 'filled' || i < 0 || i >= choices.length) return false;
    if (!answerIO.fill(choices[i])) return false;
    chosen = i;
    indicator.setChoices(choices, chosen, question?.mode === 'ja-kana' ? 'ja' : 'en');
    return true;
  }

  // True while the answer box still holds one of the offered readings, i.e.
  // the user hasn't started typing their own.
  function choosing() {
    return state === 'filled' && choices.length > 1 && choices.includes(answerIO.value());
  }

  function clearFollowUp() {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }

  function modeModel() {
    return modeModels && question ? modeModels[question.mode] : undefined;
  }

  // Message for the idle state, given model availability.
  function readyMessage() {
    const key = keyLabel(settings.pttKey);
    if (isFake()) return `Test mode (no mic): type below, then hold ${key}`;
    const s = modelStatus.get(modeModel());
    if (s?.status === 'loading') {
      const pct = s.total ? ` ${Math.floor((100 * s.loaded) / s.total)}%` : '';
      return `Loading speech model…${pct}`;
    }
    if (s?.status === 'error') return `Speech model failed to load: ${s.message}`;
    return `Hold ${key} to answer`;
  }

  // ---- state transitions ---------------------------------------------------

  function enterReady(message) {
    clearFollowUp();
    if (!isFake() && modeModels && modeModel() === null) {
      setState('manual', 'No voice model for this question type: type this one');
      return;
    }
    if (handsFree() && !document.hidden) {
      startListening();
    } else {
      setState('ready', message ?? (document.hidden ? 'Paused while the tab is hidden' : readyMessage()));
    }
  }

  function showError(reason, retryMs = 2000) {
    const gen = generation;
    setState('error', reason);
    followUpTimer = setTimeout(() => {
      if (gen !== generation || state !== 'error') return;
      enterReady(handsFree() ? undefined : `${reason} — hold ${keyLabel(settings.pttKey)} to retry`);
    }, retryMs);
  }

  function onNewQuestion(q) {
    generation += 1;
    question = q;
    pttHeld = false;
    cancelCapture();
    enterReady();
  }

  function onGraded() {
    generation += 1;  // drop anything still in flight for this question
    pttHeld = false;
    cancelCapture();
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

  // Firefox won't run audio until the user has interacted with the page.
  // After a blocked start, the next click or key press retries listening.
  function retryOnGesture() {
    const retry = () => {
      window.removeEventListener('pointerdown', retry, true);
      window.removeEventListener('keydown', retry, true);
      if (active && state === 'error') enterReady();
    };
    window.addEventListener('pointerdown', retry, true);
    window.addEventListener('keydown', retry, true);
  }

  function micErrorMessage(err) {
    if (err?.name === 'AudioBlockedError') {
      return `Click the page or press ${keyLabel(settings.pttKey)} to start listening`;
    }
    if (err?.name === 'NotAllowedError') {
      return 'Microphone blocked: allow it for wanikani.com (icon in the address bar)';
    }
    if (err?.name === 'NotFoundError') return 'No microphone found';
    return `Microphone error: ${err?.message ?? err}`;
  }

  async function startListening() {
    if (!question) return;
    clearFollowUp();
    const token = ++listenToken;
    if (isFake()) {
      setState('listening', 'Test mode: using the text typed below');
      return;
    }
    const firstOpen = !mic.isOpen();
    setState('listening', firstOpen ? 'Starting microphone…' : 'Listening…');
    try {
      await mic.start({
        handsFree: handsFree() && !pttHeld,
        onEnd: () => { if (token === listenToken) finishListening(); },
      });
    } catch (err) {
      if (token !== listenToken) return;
      mic.cancel();
      // No automatic retry: a blocked mic would just fail again.
      setState('error', micErrorMessage(err));
      if (err?.name === 'AudioBlockedError') retryOnGesture();
      return;
    }
    if (token !== listenToken || state !== 'listening') {
      mic.cancel();
      return;
    }
    // The first push-to-talk press may have been spent on the permission
    // prompt; don't record the tail end of it.
    if (firstOpen && !handsFree() && !pttHeld) {
      mic.cancel();
      enterReady(`Microphone ready: hold ${keyLabel(settings.pttKey)} and speak`);
      return;
    }
    setState('listening', 'Listening…');
  }

  async function finishListening() {
    if (state !== 'listening' || !question) return;
    listenToken += 1;
    const gen = generation;
    const mode = question.mode;
    const request = { type: 'wkv:transcribe', mode };
    if (isFake()) {
      const text = indicator.fakeUtterance();
      if (!text.trim()) {
        showError('Test mode has no microphone: type an answer in the field below first', 3000);
        return;
      }
      request.fakeUtterance = text;
    } else {
      const clip = mic.stop();
      if (!clip) {
        enterReady();
        return;
      }
      // Don't hand silence to Whisper: it tends to "hear" something anyway.
      if (!clip.heardSpeech) {
        showError("Didn't hear anything");
        return;
      }
      request.audio = clip.audio;
    }
    setState('processing');
    let result;
    try {
      // The whole request: a mode and the user's speech. No page content.
      result = await browser.runtime.sendMessage(request);
    } catch (err) {
      result = { ok: false, reason: `Recognizer error: ${err.message}` };
    }
    if (gen !== generation || state !== 'processing') return; // question moved on
    if (!result?.ok) {
      showError(result?.reason ?? "Didn't catch that");
      return;
    }
    if (!answerIO.fill(result.text)) {
      setState('error', "Couldn't fill the answer box");
      return;
    }
    if (settings.submitMode === 'auto-submit') {
      setState('filled', result.text);
      answerIO.submit();
    } else if (result.choices?.length > 1) {
      choices = result.choices;
      chosen = 0;
      setState('filled', choicesMessage());
      indicator.setChoices(choices, chosen, question?.mode === 'ja-kana' ? 'ja' : 'en');
    } else {
      setState('filled', `${result.text} — Enter to submit, or ${keyLabel(settings.pttKey)} to retry`);
    }
  }

  function cancelCapture() {
    listenToken += 1;
    mic?.cancel();
  }

  function cancelListening() {
    pttHeld = false;
    cancelCapture();
    if (state === 'listening') enterReady();
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
        cancelCapture();
        mic?.close();
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
        cancelCapture();
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

  // ---- background channel ----------------------------------------------------

  function onBackgroundMessage(msg) {
    if (msg?.type === 'capabilities') {
      modeModels = msg.modes;
    } else if (msg?.type === 'model') {
      modelStatus.set(msg.model, msg);
    } else {
      return;
    }
    if (!active || !question) return;
    // Refresh idle states that depend on model availability.
    if (state === 'ready' || state === 'manual') enterReady();
    else if (state === 'listening' && modeModel() === null) {
      cancelCapture();
      enterReady();
    }
  }

  // Firefox unloads an idle background page (after 30 s by default) even
  // while a port is open, and the loaded speech model with it (spike S2,
  // 2026-10-04). Each message resets that idle timer, so a review tab sends a
  // small heartbeat while it's open.
  const HEARTBEAT_MS = 5000;
  let heartbeat = null;

  function connectBackground() {
    if (port || !active || isFake()) return;
    port = browser.runtime.connect({ name: 'wkv-session' });
    port.onMessage.addListener(onBackgroundMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      clearInterval(heartbeat);
      if (active) setTimeout(connectBackground, 1000);
    });
    port.postMessage({ type: 'warmup' });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => port?.postMessage({ type: 'heartbeat' }), HEARTBEAT_MS);
  }

  function disconnectBackground() {
    clearInterval(heartbeat);
    port?.disconnect();
    port = null;
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
    // 1–3 pick another offered reading (only while one is in the box).
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (digit && !e.ctrlKey && !e.altKey && !e.metaKey && !indicator.ownsEvent(e) && choosing()) {
      if (pick(Number(digit[1]) - 1)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
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
      // In hands-free mode PTT takes over an automatic listen: restart it so
      // the end is decided by the key, not the speech detector.
      if (state === 'listening') cancelCapture();
      startListening();
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

  // Never listen in a tab the user has left; release the mic while hidden.
  function onVisibility() {
    if (document.hidden) {
      cancelListening();
      mic?.close();
      if (state === 'listening' || state === 'ready') enterReady();
    } else if (state === 'ready') {
      enterReady();
    }
  }
  function onBlur() {
    if (pttHeld) cancelListening();
  }

  // ---- lifecycle -----------------------------------------------------------

  function activate() {
    active = true;
    indicator = WKV.indicator.create({ onToggle, onFakeUtterance, onPick: pick });
    indicator.setDevMode(isFake());
    mic = WKV.audio.createMic();
    state = 'off';
    question = null;
    lastGraded = false;
    setState(settings.enabled ? 'unsupported' : 'off');
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keypress', onKeyPress, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('didAnswerQuestion', scheduleEvaluate);
    window.addEventListener('willShowNextQuestion', scheduleEvaluate);
    observer = new MutationObserver(records => {
      if (records.some(r => !indicator.ownsNode(r.target))) scheduleEvaluate();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    connectBackground();
    scheduleEvaluate();
  }

  function deactivate() {
    active = false;
    generation += 1;
    clearFollowUp();
    cancelCapture();
    mic?.close();
    mic = null;
    disconnectBackground();
    observer?.disconnect();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('keypress', onKeyPress, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
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
    const wasFake = isFake();
    settings = next;
    if (!active) return;
    if (wasFake !== isFake()) {
      indicator.setDevMode(isFake());
      if (isFake()) {
        cancelCapture();
        mic.close();
        disconnectBackground();
      } else {
        connectBackground();
      }
    }
    // Re-enter the current question under the new settings.
    cancelCapture();
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
