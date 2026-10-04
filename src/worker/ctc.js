// CTC decoding for the hiragana model: prefix beam search returning the most
// likely distinct readings. The alternatives come from the audio alone; the
// question is never involved.

function logSumExp(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

// logits: Float32Array of frames x vocab (row-major). Returns up to topK
// { ids, logProb } sorted best first; ids are collapsed (no blanks/repeats).
export function ctcBeamSearch(logits, frames, vocab, { blank = 0, beam = 16, perFrame = 8, topK = 3 } = {}) {
  // Beams: prefix key -> { ids, pb (ends in blank), pnb (ends in non-blank) }
  let beams = new Map([['', { ids: [], pb: 0, pnb: -Infinity }]]);
  const logp = new Float32Array(vocab);
  for (let t = 0; t < frames; t++) {
    // log-softmax for this frame
    const row = logits.subarray(t * vocab, (t + 1) * vocab);
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) max = Math.max(max, row[v]);
    let sum = 0;
    for (let v = 0; v < vocab; v++) sum += Math.exp(row[v] - max);
    const lse = max + Math.log(sum);
    for (let v = 0; v < vocab; v++) logp[v] = row[v] - lse;
    // Only extend with this frame's most likely tokens.
    const candidates = [...logp.keys()].sort((a, b) => logp[b] - logp[a]).slice(0, perFrame);

    const next = new Map();
    const get = (key, ids) => {
      if (!next.has(key)) next.set(key, { ids, pb: -Infinity, pnb: -Infinity });
      return next.get(key);
    };
    for (const [key, b] of beams) {
      const total = logSumExp(b.pb, b.pnb);
      const last = b.ids.length ? b.ids[b.ids.length - 1] : -1;
      for (const v of candidates) {
        const p = logp[v];
        if (v === blank) {
          const e = get(key, b.ids);
          e.pb = logSumExp(e.pb, total + p);
          continue;
        }
        const ids = [...b.ids, v];
        const ext = get(`${key},${v}`, ids);
        if (v === last) {
          // A repeat only extends the prefix across a blank...
          ext.pnb = logSumExp(ext.pnb, b.pb + p);
          // ...otherwise it collapses into the same prefix.
          const same = get(key, b.ids);
          same.pnb = logSumExp(same.pnb, b.pnb + p);
        } else {
          ext.pnb = logSumExp(ext.pnb, total + p);
        }
      }
    }
    beams = new Map([...next].sort((x, y) => logSumExp(y[1].pb, y[1].pnb) - logSumExp(x[1].pb, x[1].pnb)).slice(0, beam));
  }
  return [...beams.values()]
    .map(b => ({ ids: b.ids, logProb: logSumExp(b.pb, b.pnb) }))
    .sort((a, b) => b.logProb - a.logProb)
    .slice(0, topK);
}
