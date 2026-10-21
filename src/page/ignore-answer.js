// "Ignore" for a wrong answer, like the Double-Check script's re-type: the
// question comes back as if it hadn't been answered, and WaniKani doesn't
// count it. Runs in the page's own JavaScript context (manifest "world":
// "MAIN"), because it works through WaniKani's Stimulus controllers; the
// content scripts can't reach them.
//
// How WaniKani handles an answer (its quiz_input / quiz_queue controllers,
// read 2026-10-20): quiz-input grades it and calls quiz-queue's
// submitAnswer(answer, results) straight away. For a wrong answer that only
// adds 1 to the item's incorrect count for that question type, moves the
// item further back in the active queue and fires didAnswerQuestion (the
// statistics and the recent-answers log listen). Nothing goes to WaniKani's
// server until both halves of an item are answered right
// (api.itemComplete), so a wrong answer can still be taken back: put the
// count and the queue back as they were, and reset the answer box.
//
// What it shares with the extension: data-wkv-ignore on <html>, "ready"
// (hooked), "pending" (a wrong answer can be ignored now) or absent. It
// reads data-wkv-ignore-enabled (set by src/content/answer-io.js from the
// setting) and listens for a "wkv-ignore-answer" event. Nothing about the
// question or the answer ever leaves this script: the subject, the stats and
// the answer stay inside WaniKani's own objects.
(function () {
  'use strict';

  const root = document.documentElement;
  let hooked = null;  // the quiz-queue controller we wrapped
  let pending = null; // what to restore if the wrong answer just given is ignored

  const controller = name => {
    const el = document.querySelector(`[data-controller~="${name}"]`);
    return el && window.Stimulus?.getControllerForElementAndIdentifier(el, name);
  };
  const enabled = () => root.dataset.wkvIgnoreEnabled === 'true';
  // Double-Check replaces the same handlers and has its own re-type.
  const doubleCheck = () => !!window.doublecheck;

  function setStatus(status) {
    if (status) root.dataset.wkvIgnore = status;
    else delete root.dataset.wkvIgnore;
  }

  function hook() {
    const queue = controller('quiz-queue');
    if (!queue?.quizQueue || queue === hooked || doubleCheck()) return;
    const submitAnswer = queue.submitAnswer;
    const nextItem = queue.nextItem;
    queue.submitAnswer = function (answer, results) {
      pending = null;
      const q = this.quizQueue;
      if (!enabled() || doubleCheck() || results?.action === 'pass' || !q?.currentItem) {
        return submitAnswer.call(this, answer, results);
      }
      const stats = controller('quiz-statistics');
      const lastAnswers = controller('last-answers');
      const snapshot = {
        item: q.currentItem,
        stat: JSON.parse(JSON.stringify(q.stats.get(q.currentItem))),
        activeQueue: q.activeQueue.slice(),
        statistics: stats && { answeredCount: stats.answeredCount, incorrectCount: stats.incorrectCount,
          percent: stats.percentCorrectTarget?.innerText },
        lastAnswers,
        event: null,
      };
      // The recent-answers log (WaniKani's local answer history) gets the
      // wrong answer only once it's kept: on to the next question.
      const capture = e => { snapshot.event = e; };
      window.addEventListener('didAnswerQuestion', capture, { once: true });
      lastAnswers?.disconnect();
      try {
        return submitAnswer.call(this, answer, results);
      } finally {
        window.removeEventListener('didAnswerQuestion', capture);
        if (lastAnswers) window.addEventListener('didAnswerQuestion', lastAnswers.didAnswerQuestion);
        // Its answer listener only: connect() would also re-render the log.
        pending = snapshot;
        setStatus('pending');
      }
    };
    queue.nextItem = function (...args) {
      // Moving on keeps the wrong answer: log it now.
      if (pending?.event && pending.lastAnswers) pending.lastAnswers.didAnswerQuestion(pending.event);
      pending = null;
      setStatus('ready');
      return nextItem.apply(this, args);
    };
    hooked = queue;
    setStatus('ready');
  }

  function ignore() {
    const snapshot = pending;
    const queue = hooked;
    if (!snapshot || !queue) return;
    pending = null;
    const q = queue.quizQueue;
    q.stats.set(snapshot.item, snapshot.stat);
    q.activeQueue = snapshot.activeQueue;
    const stats = controller('quiz-statistics');
    if (stats && snapshot.statistics) {
      stats.answeredCount = snapshot.statistics.answeredCount;
      stats.incorrectCount = snapshot.statistics.incorrectCount;
      if (stats.percentCorrectTarget && snapshot.statistics.percent !== undefined) {
        stats.percentCorrectTarget.innerText = snapshot.statistics.percent;
      }
    }
    controller('additional-content')?.close();
    controller('item-info')?.disable();
    // The answer box, as when a question loads.
    const input = controller('quiz-input');
    if (input) {
      input.clearException?.();
      input.inputContainerTarget.removeAttribute('correct');
      input.inputTarget.value = '';
      input.inputChars = '';
      input.inputEnabled = true;
      if (input.currentQuestionType === 'reading') input.bindWanakana?.();
      input.inputTarget.focus();
    }
    // For other scripts, as Double-Check announces its re-type.
    window.dispatchEvent(new CustomEvent('didUnanswerQuestion'));
    setStatus('ready');
  }

  window.addEventListener('wkv-ignore-answer', ignore);
  // The quiz controllers connect after the page loads, and again after
  // WaniKani's Turbo navigation; look for them until they're there.
  // Nothing is wrapped until the setting is on.
  function watch() {
    if (hooked && !document.contains(hooked.element)) {
      hooked = null;
      pending = null;
      setStatus(null);
    }
    if (!enabled() || !document.querySelector('[data-controller~="quiz-queue"]')) return;
    try { hook(); } catch (err) { console.warn('Voice Answers: ignore-answer hook failed', err); }
  }
  setInterval(watch, 500);
  watch();
})();
