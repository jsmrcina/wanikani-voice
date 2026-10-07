// Moonshine repeat collapsing (collapseRepeats in src/worker/recognize.js).
// Results land in #repeat-results.
import { collapseRepeats } from '/src/worker/recognize.js';

const cases = [
  // Seen in use (2026-10-06).
  ['north country north country north country', 'north country'],
  ['barbarbar', 'bar'],
  ['barbar barbar', 'bar'],
  ['King king', 'King'],
  ['21 21', '21'],
  ['Rice field rice field.', 'Rice field'],
  ['bar. bar. bar.', 'bar'],
  // Left alone: real words, hyphenated answers, ordinary text.
  ['murmur', 'murmur'],
  ['tutu', 'tutu'],
  ['So-so.', 'So-so.'],
  ['hand and', 'hand and'],
  ['fire', 'fire'],
  ['', ''],
];
const failures = [];
for (const [input, want] of cases) {
  const got = collapseRepeats(input);
  if (got !== want) failures.push({ input, got, want });
}
document.getElementById('repeat-results').textContent = JSON.stringify({ total: cases.length, failures });
