// The status panel injected into the review page: icon, status message,
// EN/かな mode tag and the mic button, plus answer choices, Submit / Clear /
// Next buttons and the test-mode field when they apply.
//
// Every keyboard action has a pointer (touch, mouse, pen) equivalent here:
// press and hold the mic button to talk (let go well away from it to cancel), tap a choice,
// tap Submit / Next. Clear (touch screens only) empties the answer box
// without bringing up the on-screen keyboard. While voice answers are off
// (paused in the settings), pressing the mic turns them back on. On narrow screens the panel is a full-width
// bar at the bottom (or top) of the page.
//
// Lives in a closed shadow root so WaniKani's CSS can't restyle it and page
// scripts can't reach inside. The host element mirrors the state in
// data-state / data-mode attributes, for styling hooks and for tests.
(function (WKV) {
  'use strict';

  const MIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`;
  const MIC_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 11h-2a5 5 0 0 1-.7 2.53l1.46 1.46A6.96 6.96 0 0 0 19 11Zm-4 .17V5a3 3 0 0 0-5.94-.6L15 10.34v.83ZM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.08 2.8l1.56 1.56A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.89-1.13L19.73 21 21 19.73 4.27 3Z"/></svg>`;

  // The add-on icon (icons/icon.svg), inlined by tools/build.mjs so the page
  // never loads anything from the extension. Empty in an unbuilt checkout.
  const ICON_SVG = '';

  const CSS = `
    :host { all: initial; }
    :host {
      --panel: #ffffff; --fg: #1f2328; --muted: #6b7280; --border: #d0d7de; --chip: #f3f4f6;
      --listen: #e5484d; --busy: #3e63dd; --ok: #30a46c; --warn: #d98a04; --off: #9ca3af;
      --shadow: 0 6px 24px rgb(0 0 0 / .18), 0 1px 3px rgb(0 0 0 / .12);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --panel: #1e2126; --fg: #e6e8eb; --muted: #9aa1ab; --border: #3a3f47; --chip: #2a2e35;
        --warn: #f5a524; --shadow: 0 6px 24px rgb(0 0 0 / .55), 0 1px 3px rgb(0 0 0 / .4);
      }
    }
    .wrap {
      position: fixed; top: calc(72px + var(--vv-top, 0px)); right: 16px; z-index: 2147483647;
      box-sizing: border-box; min-width: 220px; max-width: min(360px, calc(100vw - 32px));
      display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 8px 10px;
      background: var(--panel); color: var(--fg); border: 1.5px solid var(--border);
      border-radius: 14px; box-shadow: var(--shadow);
      font: 13px/1.35 system-ui, sans-serif; transition: border-color .15s;
    }
    .wrap[data-pos$="left"] { right: auto; left: 16px; }
    .wrap[data-pos^="bottom"] { top: auto; bottom: calc(16px + var(--vv-bottom, 0px)); }
    /* Anchored at the bottom, rows that come and go (choices, Submit / Next)
       go above the mic row, so the mic doesn't move under a finger pressing
       it (Pixel 9 Pro XL, 2026-10-06). */
    .wrap[data-pos^="bottom"] { flex-direction: column-reverse; }
    /* Phones: a full-width bar at the bottom (default there) or the top. */
    @media (max-width: 600px) {
      .wrap, .wrap[data-pos$="left"] {
        left: 8px; right: 8px; top: calc(8px + var(--vv-top, 0px)); min-width: 0; max-width: none;
      }
      .wrap[data-pos^="bottom"] {
        top: auto; bottom: calc(8px + max(var(--vv-bottom, 0px), env(safe-area-inset-bottom, 0px)));
      }
    }
    .wrap, .wrap button {
      user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    .row { display: flex; align-items: center; gap: 8px; }
    .logo { flex: none; width: 24px; height: 24px; }
    .logo svg { display: block; width: 100%; height: 100%; }
    .bubble { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .mode {
      flex: none; min-width: 2.2em; padding: 2px 6px; border-radius: 6px; text-align: center;
      background: var(--chip); font-weight: 600; font-size: 12px;
    }
    .mode:empty { display: none; }
    .badge {
      flex: none; position: relative; width: 36px; height: 36px; border-radius: 50%;
      border: 1px solid var(--border); background: var(--chip); color: var(--off);
      cursor: pointer; padding: 0; display: grid; place-items: center;
    }
    .badge svg { width: 20px; height: 20px; }
    .badge:focus-visible, .actions button:focus-visible { outline: 2px solid var(--busy); outline-offset: 2px; }
    /* Hold-to-talk: no scrolling, zooming or long-press menu while held. */
    .badge { touch-action: none; }
    .actions { display: none; gap: 6px; justify-content: flex-end; }
    .actions.on { display: flex; }
    .actions button {
      font: 600 13px/1.3 system-ui, sans-serif; padding: 5px 14px; border-radius: 8px; cursor: pointer;
      background: var(--chip); color: var(--fg); border: 1.5px solid var(--border);
    }
    .actions button.primary { background: var(--ok); border-color: var(--ok); color: #fff; }
    .actions button[hidden] { display: none; }
    /* Touch screens: finger-sized targets. */
    @media (pointer: coarse) {
      .badge { width: 56px; height: 56px; }
      .badge svg { width: 28px; height: 28px; }
      .choices button { min-height: 44px; padding: 6px 14px; font-size: 18px; }
      .actions button { min-height: 44px; padding: 8px 18px; font-size: 15px; }
      .dev button { min-height: 44px; }
      .wrap { font-size: 14px; }
    }
    .choices { display: none; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .choices.on { display: flex; }
    .choices button {
      font: 600 16px/1.3 system-ui, sans-serif; padding: 4px 10px; border-radius: 8px; cursor: pointer;
      background: var(--chip); color: var(--fg); border: 1.5px solid transparent;
    }
    .choices button:hover { border-color: var(--border); }
    .choices button[aria-pressed="true"] { border-color: var(--ok); background: var(--panel); }
    .choices kbd { font: 11px ui-monospace, monospace; color: var(--muted); margin-right: 5px; }
    .dev { display: none; }
    .dev.on { display: flex; flex-direction: column; gap: 3px; padding-top: 8px; border-top: 1px solid var(--border); }
    .dev input {
      box-sizing: border-box; width: 100%; font: inherit; padding: 5px 8px; border-radius: 8px;
      border: 1px dashed var(--muted); background: var(--panel); color: var(--fg);
    }
    .dev small { color: var(--muted); font-size: 11px; }
    .dev .devrow { display: flex; gap: 6px; }
    .dev .devrow input { flex: 1; min-width: 0; }
    .dev button {
      font: inherit; padding: 4px 10px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--border); background: var(--chip); color: var(--fg);
    }

    [data-state="ready"] .badge, [data-state="filled"] .badge { color: var(--fg); }
    [data-state="listening"] { border-color: var(--listen); }
    [data-state="listening"] .badge { color: #fff; background: var(--listen); border-color: var(--listen); }
    [data-state="listening"] .badge::after {
      content: ""; position: absolute; inset: -5px; border-radius: 50%;
      border: 2px solid var(--listen); animation: pulse 1.2s ease-out infinite;
    }
    [data-state="processing"] { border-color: var(--busy); }
    [data-state="processing"] .badge { color: var(--busy); }
    [data-state="processing"] .badge::after {
      content: ""; position: absolute; inset: -4px; border-radius: 50%;
      border: 3px solid transparent; border-top-color: var(--busy); animation: spin .8s linear infinite;
    }
    [data-state="filled"] { border-color: var(--ok); }
    [data-state="error"] { border-color: var(--warn); }
    [data-state="error"] .badge { color: var(--warn); border-color: var(--warn); }
    [data-state="off"] .bubble, [data-state="manual"] .bubble, [data-state="unsupported"] .bubble { color: var(--muted); }
    [data-state="off"] .mode, [data-state="unsupported"] .mode { display: none; }
    [data-state="manual"] .badge { color: var(--muted); }
    @keyframes pulse { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(1.35); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .wrap { transition: none; }
      [data-state="listening"] .badge::after, [data-state="processing"] .badge::after { animation: none; }
    }
  `;

  const LABELS = {
    off: 'Voice answers are off: press the mic to turn them on',
    unsupported: "Can't read the question type on this page",
    waiting: 'Waiting for the next question',
    ready: 'Ready',
    listening: 'Listening…',
    processing: 'Processing…',
    filled: 'Answer filled in',
    manual: 'Voice answers not available for this question type yet',
    error: 'Error',
  };

  // Parses the constant markup above into nodes (no innerHTML assignment:
  // add-on reviewers flag it even for static strings).
  function parse(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    return [...doc.body.childNodes].map(n => document.importNode(n, true));
  }

  function create({ onToggle, onFakeUtterance, onPick, onTalkStart, onTalkEnd, onTalkCancel, onSubmit, onNext, onClear }) {
    // An extension reload leaves the previous instance's badge orphaned in
    // the page; remove it. Only our own top-level elements are looked at.
    for (const el of [...document.documentElement.children]) {
      if (el.localName === 'wkv-indicator') el.remove();
    }
    const host = document.createElement('wkv-indicator');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style, ...parse(`
      <div class="wrap" data-state="off">
        <div class="row">
          <span class="logo" title="Voice Answers for WaniKani"></span>
          <div class="bubble" role="status" aria-live="polite"></div>
          <span class="mode"></span>
          <button class="badge" type="button"></button>
        </div>
        <div class="choices" role="group" aria-label="Other answers heard"></div>
        <div class="actions">
          <button class="submit primary" type="button" hidden>Submit</button>
          <button class="clear" type="button" hidden>Clear</button>
          <button class="next" type="button" hidden>Next</button>
        </div>
        <div class="dev">
          <div class="devrow">
            <input type="text" placeholder="Type a test answer here" lang="ja" autocomplete="off" spellcheck="false">
            <button class="send" type="button">Send</button>
          </div>
          <small>Test mode: no microphone is used. This text stands in for your voice.</small>
        </div>
      </div>`));
    const wrap = root.querySelector('.wrap');
    const badge = root.querySelector('.badge');
    const mode = root.querySelector('.mode');
    const bubble = root.querySelector('.bubble');
    const dev = root.querySelector('.dev');
    const devInput = dev.querySelector('input');
    const choices = root.querySelector('.choices');
    const actions = root.querySelector('.actions');
    const submitButton = root.querySelector('.submit');
    const nextButton = root.querySelector('.next');
    const clearButton = root.querySelector('.clear');
    if (ICON_SVG) root.querySelector('.logo').append(...parse(ICON_SVG));
    else root.querySelector('.logo').remove();

    // Press and hold the mic button to talk. Pointer events cover touch,
    // mouse and pen. The press stays with the button while held (pointer
    // capture), since a thumb drifts while talking: on the Pixel 9 Pro XL
    // (2026-10-06) half the holds ended just outside the 56 px button. Only
    // letting go well away from where the press started cancels (not from
    // the button: the panel may change size while held), like typing a
    // capital with Shift does for the keyboard push-to-talk.
    const CANCEL_DISTANCE_PX = 72;
    let held = null; // pointerId while held
    let downAt = null; // { x, y } of the press
    badge.addEventListener('pointerdown', e => {
      if (e.button !== 0 || held !== null) return;
      e.preventDefault(); // no focus change, text selection or emulated mouse events
      if (host.dataset.state === 'off') {
        onToggle();
        return;
      }
      held = e.pointerId;
      downAt = { x: e.clientX, y: e.clientY };
      badge.setPointerCapture(e.pointerId);
      onTalkStart?.();
    });
    const release = (e, cancel) => {
      if (held !== e.pointerId) return;
      held = null;
      (cancel ? onTalkCancel : onTalkEnd)?.();
    };
    badge.addEventListener('pointerup', e => {
      const away = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > CANCEL_DISTANCE_PX;
      release(e, away);
    });
    badge.addEventListener('pointercancel', e => release(e, true));
    badge.addEventListener('lostpointercapture', e => release(e, true));
    badge.addEventListener('contextmenu', e => e.preventDefault()); // Android long press
    submitButton.addEventListener('click', () => onSubmit?.());
    nextButton.addEventListener('click', () => onNext?.());
    clearButton.addEventListener('click', () => onClear?.());
    root.querySelector('.send').addEventListener('click', () => onFakeUtterance());
    // Keys typed in the test field must not reach WaniKani's hotkeys.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      devInput.addEventListener(type, e => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Enter') {
          e.preventDefault();
          onFakeUtterance();
        }
      });
    }

    document.documentElement.appendChild(host);

    function set(state, { mode: m, message } = {}) {
      wrap.dataset.state = state;
      host.dataset.state = state;
      host.dataset.mode = m || '';
      mode.textContent = m === 'ja-kana' ? 'かな' : m === 'en' ? 'EN' : '';
      badge.replaceChildren(...parse(['off', 'unsupported', 'manual'].includes(state) ? MIC_OFF : MIC));
      badge.title = state === 'off' ? LABELS.off : 'Hold to talk';
      badge.setAttribute('aria-label', badge.title);
      bubble.textContent = message ?? '';
      host.dataset.message = message ?? '';
    }

    // Alternatives for the answer just recognised; `selected` is filled in.
    // `lang` is 'ja' for readings, so screen readers and fonts treat kana right.
    function setChoices(list = [], selected = 0, lang = '') {
      choices.lang = lang;
      choices.replaceChildren(...list.map((text, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(i === selected));
        const k = document.createElement('kbd');
        k.textContent = String(i + 1);
        b.append(k, text);
        b.addEventListener('click', () => onPick?.(i));
        return b;
      }));
      choices.classList.toggle('on', list.length > 1);
      host.dataset.choices = list.length > 1 ? list.join('|') : '';
      host.dataset.selected = list.length > 1 ? String(selected) : '';
    }

    // Which on-panel action buttons are offered: Submit and Clear (an answer
    // is filled in) and Next (the answer has been graded).
    function setActions({ submit = false, clear = false, next = false } = {}) {
      submitButton.hidden = !submit;
      clearButton.hidden = !clear;
      nextButton.hidden = !next;
      actions.classList.toggle('on', submit || clear || next);
      host.dataset.actions = [submit && 'submit', clear && 'clear', next && 'next'].filter(Boolean).join(' ');
    }

    // Keep the panel in the visible part of the page. Firefox for Android
    // shrinks only the visual viewport for the on-screen keyboard, so a fixed
    // panel at the bottom would sit under the keyboard: lift it by the part of
    // the layout viewport the keyboard covers (and follow the visible area
    // down when it's scrolled or zoomed).
    const vv = window.visualViewport;
    function followViewport() {
      const layoutHeight = document.documentElement.clientHeight;
      const top = Math.max(0, vv.offsetTop);
      const bottom = Math.max(0, layoutHeight - (vv.offsetTop + vv.height));
      wrap.style.setProperty('--vv-top', `${Math.round(top)}px`);
      wrap.style.setProperty('--vv-bottom', `${Math.round(bottom)}px`);
    }
    if (vv) {
      vv.addEventListener('resize', followViewport);
      vv.addEventListener('scroll', followViewport);
      followViewport();
    }

    const POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
    function setPosition(pos) {
      wrap.dataset.pos = POSITIONS.includes(pos) ? pos : 'top-right';
    }

    return {
      set,
      setChoices,
      setPosition,
      setActions,
      setDevMode(on) { dev.classList.toggle('on', on); },
      fakeUtterance() { return devInput.value; },
      ownsEvent(e) { return e.composedPath().includes(host); },
      ownsNode(node) { return node === host || host.contains(node); },
      isAttached() { return host.isConnected; },
      reattach() { if (!host.isConnected) document.documentElement.appendChild(host); },
      destroy() {
        vv?.removeEventListener('resize', followViewport);
        vv?.removeEventListener('scroll', followViewport);
        host.remove();
      },
    };
  }

  WKV.indicator = { create };
})(globalThis.WKV = globalThis.WKV || {});
