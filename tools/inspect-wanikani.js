// Paste into the Firefox DevTools console on https://www.wanikani.com/subjects/review
// (Firefox asks you to type "allow pasting" first).
//
// Records the structure of the quiz input area and WaniKani's quiz events while
// you do a few reviews, then saves a JSON file to your Downloads folder.
// It never records the question characters, item info, or event payloads —
// only markup structure (with text redacted outside the question-type labels)
// and the *names/keys* of events.
//
//   wkvSnap('label')  take an extra snapshot now
//   wkvSave()         download wkv-inspect-<time>.json and stop recording
(() => {
  const KEEP_TEXT = '.quiz-input__question-category, .quiz-input__question-type';
  const log = [];
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);

  function redactedHtml(el) {
    if (!el) return null;
    const clone = el.cloneNode(true);
    const keep = new Set(clone.querySelectorAll(KEEP_TEXT));
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) {
      const parent = node.parentElement;
      if (parent && [...keep].some(k => k === parent || k.contains(parent))) continue;
      if (node.textContent.trim()) node.textContent = '[…]';
    }
    for (const e of [clone, ...clone.querySelectorAll('*')]) {
      for (const a of ['value', 'aria-label', 'title', 'alt', 'placeholder', 'href', 'src']) {
        if (e.hasAttribute(a)) e.setAttribute(a, '[…]');
      }
      if (e.tagName === 'SCRIPT' || e.tagName === 'TEMPLATE') e.textContent = '[…]';
    }
    return clone.outerHTML;
  }

  function topRightLayout() {
    const out = [];
    for (const e of document.body.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (r.width && r.height && r.top < 140 && r.right > innerWidth - 320 && r.width < innerWidth / 2) {
        out.push({ tag: e.tagName, cls: e.className?.baseVal ?? e.className, id: e.id,
                   rect: [r.left, r.top, r.width, r.height].map(Math.round) });
      }
    }
    return out.slice(0, 60);
  }

  function snap(label) {
    const input = document.querySelector('#user-response');
    const quiz = input?.closest('.quiz-input') ?? input?.closest('form')?.parentElement ?? null;
    log.push({
      t: now(), kind: 'snapshot', label, path: location.pathname,
      viewport: [innerWidth, innerHeight],
      quizInputHtml: redactedHtml(quiz),
      inputState: input ? { disabled: input.disabled, readOnly: input.readOnly,
                            lang: input.lang, focused: document.activeElement === input,
                            attrs: input.getAttributeNames() } : null,
      topRight: label === 'initial' ? topRightLayout() : undefined,
    });
  }

  const EVENTS = ['didAnswerQuestion', 'willShowNextQuestion', 'didChangeQuiz',
    'didCompleteSubject', 'didUpdateUserSynonyms', 'registerWanakanaFor',
    'unregisterWanakanaFor', 'turbo:load', 'turbo:visit', 'turbo:before-render'];
  const handlers = EVENTS.map(name => {
    const h = e => {
      log.push({ t: now(), kind: 'event', name, target: e.target === window ? 'window' : e.target?.nodeName,
                 detailKeys: e.detail && typeof e.detail === 'object' ? Object.keys(e.detail) : typeof e.detail });
      setTimeout(() => snap(`after ${name}`), 400);
    };
    window.addEventListener(name, h, true);
    return [name, h];
  });

  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof Element && m.target.closest('.quiz-input')) {
        log.push({ t: now(), kind: 'attr', el: `${m.target.tagName}.${m.target.className}`,
                   attr: m.attributeName, value: m.attributeName === 'value' ? '[…]' : m.target.getAttribute(m.attributeName) });
      }
    }
  });
  mo.observe(document.body, { subtree: true, attributes: true });

  window.wkvSnap = snap;
  window.wkvSave = () => {
    mo.disconnect();
    handlers.forEach(([n, h]) => window.removeEventListener(n, h, true));
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wkv-inspect-${Date.now()}.json`;
    a.click();
    return `${log.length} entries saved`;
  };
  snap('initial');
  return 'Recording. Do a few reviews, then run wkvSave()';
})();
