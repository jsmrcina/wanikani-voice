// The status badge injected at the top right of the review page.
//
// Lives in a closed shadow root so WaniKani's CSS can't restyle it and page
// scripts can't reach inside. The host element mirrors the state in
// data-state / data-mode attributes, for styling hooks and for tests.
(function (WKV) {
  'use strict';

  const MIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>`;
  const MIC_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 11h-2a5 5 0 0 1-.7 2.53l1.46 1.46A6.96 6.96 0 0 0 19 11Zm-4 .17V5a3 3 0 0 0-5.94-.6L15 10.34v.83ZM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.08 2.8l1.56 1.56A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.89-1.13L19.73 21 21 19.73 4.27 3Z"/></svg>`;

  const CSS = `
    :host { all: initial; }
    :host {
      --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --border: #d0d7de;
      --listen: #e5484d; --busy: #3e63dd; --ok: #30a46c; --warn: #f5a524; --off: #9ca3af;
      --shadow: 0 2px 10px rgb(0 0 0 / .18);
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #1e2126; --fg: #e6e8eb; --muted: #9aa1ab; --border: #3a3f47; --shadow: 0 2px 10px rgb(0 0 0 / .5); }
    }
    .wrap {
      position: fixed; top: 72px; right: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font: 13px/1.35 system-ui, sans-serif; color: var(--fg);
    }
    .row { display: flex; align-items: center; gap: 6px; }
    .badge {
      position: relative; width: 40px; height: 40px; border-radius: 50%;
      border: 1px solid var(--border); background: var(--bg); color: var(--off);
      box-shadow: var(--shadow); cursor: pointer; padding: 0;
      display: grid; place-items: center;
    }
    .badge svg { width: 22px; height: 22px; }
    .badge:focus-visible { outline: 2px solid var(--busy); outline-offset: 2px; }
    .mode {
      min-width: 2.5em; padding: 2px 6px; border-radius: 6px; text-align: center;
      background: var(--bg); border: 1px solid var(--border); box-shadow: var(--shadow);
      font-weight: 600; font-size: 12px;
    }
    .bubble {
      max-width: 240px; padding: 4px 8px; border-radius: 6px;
      background: var(--bg); border: 1px solid var(--border); box-shadow: var(--shadow);
    }
    .bubble:empty { display: none; }
    .dev { display: none; }
    .dev.on { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
    .dev input {
      width: 180px; font: inherit; padding: 4px 6px; border-radius: 6px;
      border: 1px dashed var(--muted); background: var(--bg); color: var(--fg);
    }
    .dev small { color: var(--muted); font-size: 11px; background: var(--bg); padding: 1px 6px; border-radius: 4px; }

    [data-state="ready"] .badge, [data-state="filled"] .badge { color: var(--fg); }
    [data-state="listening"] .badge { color: #fff; background: var(--listen); border-color: var(--listen); }
    [data-state="listening"] .badge::after {
      content: ""; position: absolute; inset: -5px; border-radius: 50%;
      border: 2px solid var(--listen); animation: pulse 1.2s ease-out infinite;
    }
    [data-state="processing"] .badge { color: var(--busy); }
    [data-state="processing"] .badge::after {
      content: ""; position: absolute; inset: -4px; border-radius: 50%;
      border: 3px solid transparent; border-top-color: var(--busy); animation: spin .8s linear infinite;
    }
    [data-state="filled"] .bubble { border-color: var(--ok); }
    [data-state="error"] .badge { color: var(--warn); border-color: var(--warn); }
    [data-state="error"] .bubble { border-color: var(--warn); }
    [data-state="off"] .mode, [data-state="unsupported"] .mode { display: none; }
    @keyframes pulse { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(1.35); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
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
    error: 'Error',
  };

  function create({ onToggle, onFakeUtterance }) {
    // An extension reload leaves the previous instance's badge orphaned in
    // the page; remove it. Only our own top-level elements are looked at.
    for (const el of [...document.documentElement.children]) {
      if (el.localName === 'wkv-indicator') el.remove();
    }
    const host = document.createElement('wkv-indicator');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap" data-state="off">
        <div class="row">
          <div class="bubble" role="status" aria-live="polite"></div>
          <span class="mode"></span>
          <button class="badge" type="button"></button>
        </div>
        <div class="dev">
          <input type="text" placeholder="Type a test answer here" lang="ja" autocomplete="off" spellcheck="false">
          <small>Test mode: no microphone is used yet. This text stands in for your voice.</small>
        </div>
      </div>`;
    const wrap = root.querySelector('.wrap');
    const badge = root.querySelector('.badge');
    const mode = root.querySelector('.mode');
    const bubble = root.querySelector('.bubble');
    const dev = root.querySelector('.dev');
    const devInput = dev.querySelector('input');

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
      badge.innerHTML = state === 'off' || state === 'unsupported' ? MIC_OFF : MIC;
      badge.title = LABELS[state] || state;
      badge.setAttribute('aria-label', badge.title);
      bubble.textContent = message ?? '';
      host.dataset.message = message ?? '';
    }

    return {
      set,
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
