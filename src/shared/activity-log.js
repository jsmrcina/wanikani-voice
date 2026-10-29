// The optional activity log (settings.activityLog, off by default): what
// happened to each spoken answer, so the speech models' weak spots can be
// found later and trained on offline (tools/analyze-log.mjs).
//
// Text only, no audio: what the recogniser heard and offered, which choice
// was picked, answers recorded over or cleared, what was submitted and
// whether WaniKani marked it correct, ignored answers, and failed attempts.
// Never the question: a question is only a number within its session.
//
// Kept in the extension's own IndexedDB on this device, appended to across
// sessions until cleared in the settings, where it can also be exported as a
// JSON Lines file. Nothing is ever sent anywhere.
//
// IndexedDB "wkv-activity-log", store "events" (auto-increment keys), one
// record per event:
//   { t: epoch ms, e: type, s: session id, q: question number, ...fields }
// The background page writes (one writer for every tab); the settings page
// reads, exports and clears. Classic script: attaches WKV.activityLog.
(function (WKV) {
  'use strict';

  const DB = 'wkv-activity-log';
  const STORE = 'events';

  // Event types and their fields (beyond t, e, s, q, mode):
  //   heard   model, ms (decoding time), audioMs (clip length), leadMs (clip start to speech), raw, candidates (as recognised), choices (as offered), repeated, rejected
  //   noAnswer  reason (e.g. "Didn't hear anything")
  //   pick    index, text, from (what the box held)
  //   retry   how ('record' | 'clear'), text (the answer recorded over or cleared)
  //   graded  answer, correct, index (in the last choices offered, else -1), choices,
  //           edited (not anything offered on this question: typed or edited),
  //           filled (if edited: what voice had put in the box)
  //   ignore  answer
  const FIELDS = {
    heard: ['model', 'ms', 'audioMs', 'leadMs', 'raw', 'candidates', 'choices', 'repeated', 'rejected'],
    noAnswer: ['reason'],
    pick: ['index', 'text', 'from'],
    retry: ['how', 'text'],
    graded: ['answer', 'correct', 'index', 'choices', 'edited', 'filled'],
    ignore: ['answer'],
  };
  const COMMON = ['s', 'q', 'mode'];
  const MAX_TEXT = 200;
  const MAX_LIST = 10;

  // Keeps only known fields, of plain types and bounded size.
  function clean(value) {
    if (typeof value === 'string') return value.slice(0, MAX_TEXT);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, MAX_LIST).map(clean).filter(v => typeof v === 'string');
    return undefined;
  }

  function sanitize(event) {
    const fields = FIELDS[event?.e];
    if (!fields) return null;
    const out = { t: Date.now(), e: event.e };
    for (const key of [...COMMON, ...fields]) {
      const v = clean(event[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  let dbPromise = null;
  function db() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  async function run(mode, fn) {
    const store = (await db()).transaction(STORE, mode).objectStore(STORE);
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Appends one event; returns false if it isn't a known event type.
  async function append(event) {
    const record = sanitize(event);
    if (!record) return false;
    await run('readwrite', store => store.add(record));
    return true;
  }

  const all = () => run('readonly', store => store.getAll());
  const clear = () => run('readwrite', store => store.clear());

  // { count, since: epoch ms of the oldest event, or null }
  async function info() {
    const count = await run('readonly', store => store.count());
    const first = count ? await run('readonly', store => store.openCursor()) : null;
    return { count, since: first?.value?.t ?? null };
  }

  // The whole log as JSON Lines, one event per line, oldest first.
  async function toJsonl() {
    return (await all()).map(e => JSON.stringify(e)).join('\n') + '\n';
  }

  WKV.activityLog = { FIELDS, sanitize, append, all, clear, info, toJsonl };
})(globalThis.WKV = globalThis.WKV || {});
