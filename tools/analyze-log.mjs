// Reads activity logs exported from the settings page (Activity log ->
// Export…, a .jsonl file) and reports where the speech models go wrong for
// you, as a starting point for more fine-tuning (tools/finetune-hiragana.py,
// tools/finetune-moonshine.py). Dev-time only; reads local files.
//
//   node tools/analyze-log.mjs LOG.jsonl [...] [--words-out FILE] [--top 20]
//
// What counts as the truth: an answer WaniKani marked correct. On such a
// question, whatever the recogniser offered first and the answer differ is
// a recognition miss you fixed (by picking another choice, recording again,
// or typing). An ignored answer followed by a correct one on the same
// question counts too. Wrong answers alone say nothing about recognition
// (you may not have known it), so they are only counted.
//
// Time per question (logs from 0.4.8 on): from the question appearing to
// its grading, overall and by how the answer got there. Times far above the
// rest (beyond the third quartile plus 3 interquartile ranges, Tukey's "far
// out") are left out as time away from the review, and counted.
//
// Two kinds of miss are listed apart: cut short (what was heard is the start
// of the answer, so push-to-talk was probably released early; not counted
// as a confusion), and answers that hardly resemble what was heard first (a
// bad mishearing, or a changed mind; the log can't tell, so check them).
//
// --words-out FILE: the readings it got wrong, as a recorder word list
// (tools/recorder/server.py --words FILE --set personal), 25% marked as a
// held-out test split, like personal/words-fute.json; each hint says what
// was heard instead. Cut-short ones are left out. Each reading's slug
// (its file name) and split come from a hash of the reading, so later runs
// never reuse a slug for another reading or move a reading between splits.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const files = args.filter((a, i) => !a.startsWith('--') && !['--words-out', '--top'].includes(args[i - 1]));
if (!files.length) {
  console.error('usage: node tools/analyze-log.mjs LOG.jsonl [...] [--words-out FILE] [--top 20]');
  process.exit(1);
}
const top = Number(opt('--top')) || 20;

const events = [];
for (const file of files) {
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (line.trim()) events.push(JSON.parse(line));
  }
}
events.sort((a, b) => a.t - b.t);

// One entry per question (session + number), in order.
const questions = new Map();
for (const e of events) {
  const key = `${e.s}:${e.q}`;
  if (!questions.has(key)) questions.set(key, { s: e.s, q: e.q, mode: e.mode, events: [] });
  const q = questions.get(key);
  q.mode ??= e.mode;
  q.events.push(e);
}

// An ignored answer brings the same question back under the next number.
const list = [...questions.values()];
list.forEach((q, i) => {
  const next = list[i + 1];
  if (q.events.some(e => e.e === 'ignore') && next?.s === q.s && next.q === q.q + 1) next.after = q;
});

// Character-level differences between what was heard and the truth, as
// merged runs: "た→て", "→う" (missed), "っ→" (extra).
function diff(heard, truth) {
  const a = [...heard];
  const b = [...truth];
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i || j) {
    if (i && j && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) { ops.push(null); i--; j--; }
    else if (i && j && d[i][j] === d[i - 1][j - 1] + 1) { ops.push([a[i - 1], b[j - 1]]); i--; j--; }
    else if (i && d[i][j] === d[i - 1][j] + 1) { ops.push([a[i - 1], '']); i--; }
    else { ops.push(['', b[j - 1]]); j--; }
  }
  ops.reverse();
  const runs = [];
  let run = null;
  for (const op of ops) {
    if (!op) { if (run) runs.push(run); run = null; continue; }
    run = run ? [run[0] + op[0], run[1] + op[1]] : [...op];
  }
  if (run) runs.push(run);
  return runs.map(([x, y]) => `${x}→${y}`);
}

// How alike two answers are, 0 to 1, by letters or kana only.
function similarity(a, b) {
  const x = a.replace(/[^\p{L}]/gu, '');
  const y = b.replace(/[^\p{L}]/gu, '');
  if (!x.length && !y.length) return 1;
  const n = Math.max(x.length, y.length);
  return 1 - diffSize(x, y) / n;
}
function diffSize(a, b) {
  const x = [...a];
  const y = [...b];
  let prev = [...Array(y.length + 1).keys()];
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

// A miss where what was heard is the start of the answer, two or more kana
// (or a word or more) short: most likely push-to-talk released too early,
// not a recognition mistake. Kept out of the confusions and --words-out.
function cutShort(heard, answer, mode) {
  if (!answer.startsWith(heard) || heard === answer) return false;
  return mode === 'ja-kana' ? [...answer].length - [...heard].length >= 2 : answer[heard.length] === ' ' || !heard.length;
}
// Below this, the answer hardly resembles what was heard first: maybe a
// mishearing, maybe you changed your mind (said "tail", then "butt"). The
// log can't tell which, so these are listed for you to check.
const UNLIKE = 0.35;

const stats = {};
const confusions = { en: new Map(), 'ja-kana': new Map() };
const missed = { en: new Map(), 'ja-kana': new Map() }; // answer → what was heard first
const flagged = { cut: [], unlike: [] };
const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const secs = (ms, lead) => (ms == null ? '' : ` (${(ms / 1000).toFixed(1)} s${lead == null ? '' : `, speech after ${(lead / 1000).toFixed(2)} s`})`);

for (const q of list) {
  const mode = q.mode ?? 'unknown';
  const s = (stats[mode] ??= { questions: 0, correct: 0, wrong: 0, firstTry: 0, otherChoice: 0, again: 0, typed: 0,
    retries: 0, noAnswer: 0, ignored: 0, fixed: 0, leads: [], times: [] });
  const graded = q.events.filter(e => e.e === 'graded').at(-1);
  const heard = [...(q.after?.events ?? []), ...q.events].filter(e => e.e === 'heard');
  if (!graded && !heard.length && !q.events.some(e => e.e === 'noAnswer')) continue;
  s.questions++;
  s.retries += q.events.filter(e => e.e === 'retry').length;
  s.noAnswer += q.events.filter(e => e.e === 'noAnswer').length;
  s.ignored += q.events.some(e => e.e === 'ignore') ? 1 : 0;
  if (!graded) continue;
  // Time on the question, including the answer ignored before it, if any.
  const before = q.after?.events.filter(e => e.e === 'graded').at(-1)?.questionMs ?? 0;
  const time = graded.questionMs == null ? null : graded.questionMs + before;
  if (!graded.correct) {
    s.wrong++;
    if (time != null) s.times.push({ ms: time, how: 'wrong' });
    continue;
  }
  s.correct++;
  // How the right answer got there: the first thing heard, another choice
  // of it, a later attempt (recorded again, or after an ignored answer), or
  // typing. edited: not anything offered on the question (logs from 0.4.5
  // on); older logs only say whether it was among the last choices.
  const how = (graded.edited ?? graded.index < 0) ? 'typed' : heard.length > 1 ? 'again' : graded.index === 0 ? 'firstTry' : 'otherChoice';
  s[how]++;
  if (time != null) s.times.push({ ms: time, how });
  // The recogniser's first impression on this question (before any retry).
  const first = heard[0]?.choices?.[0] ?? heard[0]?.raw;
  // Silence before speech on the first attempt (logs from 0.4.6 on), and
  // whether it was heard right: too little lead-in loses first sounds.
  if (heard[0]?.leadMs != null) s.leads.push({ ms: heard[0].leadMs, right: first === graded.answer });
  if (first == null || first === graded.answer || !(mode in confusions)) continue;
  s.fixed++;
  const entry = { mode, heard: first, answer: graded.answer, audioMs: heard[0].audioMs, leadMs: heard[0].leadMs };
  if (cutShort(first, graded.answer, mode)) { flagged.cut.push(entry); continue; }
  if (similarity(first, graded.answer) < UNLIKE) flagged.unlike.push(entry);
  if (!missed[mode].has(graded.answer)) missed[mode].set(graded.answer, first);
  if (mode === 'ja-kana') for (const c of diff(first, graded.answer)) count(confusions[mode], c);
  else count(confusions[mode], `${first} → ${graded.answer}`);
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Quartiles by linear interpolation.
const quantile = (sorted, p) => {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
// Drops times beyond Q3 + 3 IQR: the user most likely stepped away. Too few
// to tell (under 8), none are dropped.
function withoutOutliers(times) {
  if (times.length < 8) return { kept: times, fence: Infinity, dropped: 0 };
  const sorted = times.map(t => t.ms).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = q3 + 3 * (q3 - q1);
  const kept = times.filter(t => t.ms <= fence);
  return { kept, fence, dropped: times.length - kept.length };
}
const sec = ms => `${(ms / 1000).toFixed(1)} s`;
const pct = (n, d) => (d ? ` (${Math.round((100 * n) / d)}%)` : '');
console.log(`${events.length} events, ${list.length} questions, ${files.length} file(s)`);
for (const [mode, s] of Object.entries(stats)) {
  console.log(`\n== ${mode === 'ja-kana' ? 'readings' : mode === 'en' ? 'English' : mode}: ${s.questions} questions answered by voice`);
  console.log(`   graded correct ${s.correct}, wrong ${s.wrong}; ignored ${s.ignored}`);
  console.log(`   correct answers: first choice on the first try ${s.firstTry}${pct(s.firstTry, s.correct)}, another choice on the first try ${s.otherChoice}${pct(s.otherChoice, s.correct)},`);
  console.log(`     after recording again ${s.again}${pct(s.again, s.correct)}, typed or edited ${s.typed}${pct(s.typed, s.correct)}`);
  console.log(`   recorded over or cleared ${s.retries} times; nothing usable heard ${s.noAnswer} times`);
  console.log(`   heard wrong at first, then fixed: ${s.fixed}${pct(s.fixed, s.correct)}`);
  if (s.leads.length) {
    const sorted = s.leads.map(l => l.ms).sort((a, b) => a - b);
    console.log(`   silence before speech (correct answers, first attempt): median ${sorted[sorted.length >> 1]} ms; heard right first:`);
    for (const [lo, hi] of [[0, 300], [300, 600], [600, Infinity]]) {
      const b = s.leads.filter(l => l.ms >= lo && l.ms < hi);
      if (b.length) console.log(`     ${hi === Infinity ? `${lo} ms or more` : `${lo}-${hi} ms`}: ${b.filter(l => l.right).length} of ${b.length}${pct(b.filter(l => l.right).length, b.length)}`);
    }
  }
  if (s.times.length) {
    const { kept, fence, dropped } = withoutOutliers(s.times);
    const ms = kept.map(t => t.ms);
    console.log(`   time per question (appearing to graded): median ${sec(median(ms))}, mean ${sec(ms.reduce((a, b) => a + b, 0) / ms.length)}, ${kept.length} questions`);
    if (dropped) console.log(`     ${dropped} over ${sec(fence)} left out (away from the review?)`);
    const labels = { firstTry: 'first choice on the first try', otherChoice: 'another choice', again: 'recorded again',
      typed: 'typed or edited', wrong: 'graded wrong' };
    for (const [how, label] of Object.entries(labels)) {
      const t = kept.filter(x => x.how === how).map(x => x.ms);
      if (t.length) console.log(`     ${label}: median ${sec(median(t))} (${t.length})`);
    }
  }
  const conf = [...(confusions[mode]?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, top);
  if (conf.length) {
    console.log(mode === 'ja-kana' ? '   kana heard → kana said (most common):' : '   heard → said (most common):');
    for (const [c, n] of conf) console.log(`     ${String(n).padStart(4)}  ${c}`);
  }
}
const show = e => `${e.mode === 'ja-kana' ? 'reading' : 'English'}: ${e.heard} → ${e.answer}${secs(e.audioMs, e.leadMs)}`;
if (flagged.cut.length) {
  console.log('\nCut short? What was heard is the start of the answer (push-to-talk released early?);');
  console.log('not counted as confusions or written by --words-out:');
  for (const e of flagged.cut) console.log(`     ${show(e)}`);
}
if (flagged.unlike.length) {
  console.log('\nCheck these: the answer hardly resembles what was heard first. A bad mishearing, or');
  console.log('did you change your answer? Counted above; skip them when recording --words-out:');
  for (const e of flagged.unlike) console.log(`     ${show(e)}`);
}

const wordsOut = opt('--words-out');
if (wordsOut) {
  const unlike = new Set(flagged.unlike.filter(e => e.mode === 'ja-kana').map(e => e.answer));
  const words = [...missed['ja-kana'].entries()].map(([r, heard]) => {
    const hash = createHash('sha256').update(r).digest('hex');
    const hint = `heard as ${heard}${unlike.has(r) ? ': skip it if you had changed your answer' : ''}`;
    return { slug: `log-${hash.slice(0, 10)}`, say: r, hint, expected: r, group: 'log',
      split: parseInt(hash.slice(10, 12), 16) % 4 === 0 ? 'test' : 'train' };
  });
  await writeFile(wordsOut, JSON.stringify({
    comment: `Readings the reading model got wrong at first in the activity log (tools/analyze-log.mjs, ${new Date().toISOString().slice(0, 10)}). split: test clips are never trained on.`,
    en: [], ja: words, noise: [],
  }, null, 1) + '\n');
  console.log(`\nwrote ${words.length} readings to ${wordsOut}: record them with`);
  console.log(`  python3 tools/recorder/server.py --words ${wordsOut} --set personal`);
}
