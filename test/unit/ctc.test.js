// CTC prefix beam search (src/worker/ctc.js). Results land in #ctc-results.
import { ctcBeamSearch } from '/src/worker/ctc.js';

const V = 4; // 0 = blank, 1 = あ, 2 = い, 3 = う
// Builds frames x V logits from per-frame probability rows.
const frames = rows => new Float32Array(rows.flatMap(r => r.map(p => Math.log(p))));
const failures = [];
function check(name, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push({ name, got, want });
}

// あ あ (blank between) -> two あ; あ あ (no blank) -> one あ.
check('repeat across blank', ctcBeamSearch(frames([
  [0.05, 0.9, 0.03, 0.02], [0.9, 0.05, 0.03, 0.02], [0.05, 0.9, 0.03, 0.02],
]), 3, V, { topK: 1 })[0].ids, [1, 1]);
check('repeat collapses', ctcBeamSearch(frames([
  [0.05, 0.9, 0.03, 0.02], [0.05, 0.9, 0.03, 0.02],
]), 2, V, { topK: 1 })[0].ids, [1]);
// Ambiguous second sound: both readings offered, likelier first.
const alt = ctcBeamSearch(frames([
  [0.05, 0.9, 0.03, 0.02], [0.1, 0.02, 0.5, 0.38],
]), 2, V, { topK: 3 });
check('alternatives order', alt.slice(0, 2).map(h => h.ids), [[1, 2], [1, 3]]);
check('sorted by probability', alt[0].logProb >= alt[1].logProb, true);

document.getElementById('ctc-results').textContent = JSON.stringify({ total: 4, failures });
