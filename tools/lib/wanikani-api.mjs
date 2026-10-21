// WaniKani API v2 client for the dev tools (wk-dictionary.mjs,
// wk-meanings.mjs). The extension itself never contacts WaniKani's API:
// the dictionary is made here and imported as a file in the settings.
//
// Within WaniKani's rate limit, 60 requests a minute per token
// (https://docs.api.wanikani.com, "Rate Limit"): requests are spaced at
// least 1.1 s apart, a response saying none are left waits for the
// RateLimit-Reset time, and a 429 (or a 5xx) is retried after that reset
// (or a backoff), a few times at most. A full dictionary download is about
// 15 requests. The API applies your subscription's limits itself.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The token: WANIKANI_API_TOKEN, else the file given (default
// ~/.config/wanikani-voice/api-token). A read-only token is enough.
export async function readToken(file = join(homedir(), '.config/wanikani-voice/api-token')) {
  if (process.env.WANIKANI_API_TOKEN) return process.env.WANIKANI_API_TOKEN.trim();
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    throw new Error(`no API token: set WANIKANI_API_TOKEN or put a read-only token in ${file}`);
  }
}

export const API = 'https://api.wanikani.com/v2';
const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// log: where to report a wait after HTTP 429 or 5xx.
export function createClient(token, { log = () => {} } = {}) {
  let notBefore = 0; // earliest time (ms) of the next request

  async function get(path) {
    const url = path.startsWith(API) ? path : `${API}${path}`;
    for (let attempt = 1; ; attempt++) {
      const wait = notBefore - Date.now();
      if (wait > 0) await sleep(wait);
      notBefore = Date.now() + MIN_INTERVAL_MS;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Wanikani-Revision': '20170710' } });
      // Seconds since the epoch at which the current window ends.
      const resetMs = Number(res.headers.get('RateLimit-Reset')) * 1000;
      const untilReset = Number.isFinite(resetMs) && resetMs > 0 ? resetMs - Date.now() + 1000 : 0;
      if (res.headers.get('RateLimit-Remaining') === '0') notBefore = Math.max(notBefore, Date.now() + untilReset);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        const backoff = res.status === 429 && untilReset > 0 ? untilReset : 2000 * 2 ** attempt;
        log(`WaniKani said HTTP ${res.status}; trying again in ${Math.ceil(backoff / 1000)} s`);
        notBefore = Math.max(notBefore, Date.now() + backoff);
        continue;
      }
      if (res.status === 401) throw new Error('WaniKani rejected the API token');
      if (!res.ok) throw new Error(`WaniKani's API answered HTTP ${res.status}`);
      return res.json();
    }
  }

  // Every item of a paginated collection.
  async function* paged(path) {
    let url = path;
    while (url) {
      const page = await get(url);
      yield* page.data;
      url = page.pages?.next_url;
    }
  }

  return { get, paged };
}

// The dictionary file's contents (format 1, as src/options/dictionary.js
// validates on import): { format, kind, createdAt, subjects, meanings, readings }.
export async function downloadDictionary(token, { log = () => {}, progress = () => {} } = {}) {
  const api = createClient(token, { log });
  const meanings = new Set();
  const readings = new Set();
  let subjects = 0;
  for await (const s of api.paged('/subjects?types=radical,kanji,vocabulary,kana_vocabulary')) {
    if (s.data.hidden_at) continue; // retired from WaniKani
    subjects += 1;
    for (const m of s.data.meanings ?? []) meanings.add(m.meaning);
    // Extra answers WaniKani accepts (whitelist), not the blacklisted ones.
    for (const m of s.data.auxiliary_meanings ?? []) if (m.type === 'whitelist') meanings.add(m.meaning);
    // All of a kanji's readings: one it doesn't accept here is still a
    // real reading (WaniKani asks for another rather than marking it wrong).
    for (const r of s.data.readings ?? []) readings.add(r.reading);
    if (subjects % 500 === 0) progress(subjects);
  }
  for await (const m of api.paged('/study_materials')) {
    for (const synonym of m.data.meaning_synonyms ?? []) meanings.add(synonym);
  }
  return {
    format: 1,
    kind: 'wkv-dictionary',
    createdAt: new Date().toISOString(),
    subjects,
    meanings: [...meanings].sort(),
    readings: [...readings].sort(),
  };
}
