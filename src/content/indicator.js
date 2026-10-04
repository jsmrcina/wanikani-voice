// The status panel injected at the top right of the review page: icon,
// status message, EN/かな mode tag and the mic button, plus reading choices
// and the test-mode field when they apply.
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
      position: fixed; top: 72px; right: 16px; z-index: 2147483647;
      box-sizing: border-box; min-width: 220px; max-width: min(360px, calc(100vw - 32px));
      display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 8px 10px;
      background: var(--panel); color: var(--fg); border: 1.5px solid var(--border);
      border-radius: 14px; box-shadow: var(--shadow);
      font: 13px/1.35 system-ui, sans-serif; transition: border-color .15s;
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
    .badge:focus-visible { outline: 2px solid var(--busy); outline-offset: 2px; }
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
    off: 'Voice answers paused (click to resume)',
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

  function create({ onToggle, onFakeUtterance, onPick }) {
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
        <div class="dev">
          <input type="text" placeholder="Type a test answer here" lang="ja" autocomplete="off" spellcheck="false">
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
    if (ICON_SVG) root.querySelector('.logo').append(...parse(ICON_SVG));
    else root.querySelector('.logo').remove();

    badge.addEventListener('click', () => onToggle());
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
      badge.title = LABELS[state] || state;
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

    return {
      set,
      setChoices,
      setDevMode(on) { dev.classList.toggle('on', on); },
      fakeUtterance() { return devInput.value; },
      ownsEvent(e) { return e.composedPath().includes(host); },
      ownsNode(node) { return node === host || host.contains(node); },
      isAttached() { return host.isConnected; },
      reattach() { if (!host.isConnected) document.documentElement.appendChild(host); },
      destroy() { host.remove(); },
    };
  }

  WKV.indicator = { create };
})(globalThis.WKV = globalThis.WKV || {});
