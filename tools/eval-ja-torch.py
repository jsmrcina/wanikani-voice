"""Spike S4 (dev-time): compares hiragana CTC models on recorded readings in
PyTorch, before any of them is exported for the extension.

    python tools/eval-ja-torch.py [--set real-raw]

Needs torch + transformers. Dual-CTC models use their repo's custom code
(trust_remote_code at a pinned revision; reviewed 2026-10-04: a HuBERT/WavLM
encoder plus two linear CTC heads, nothing else).
"""
import argparse
import json
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import torch
from transformers import (AutoFeatureExtractor, AutoModel, AutoModelForCTC,
                          AutoProcessor, PreTrainedTokenizerFast)

ROOT = Path(__file__).resolve().parent.parent

CANDIDATES = [
    # (name, repo, revision, kind)
    ("distilhubert-hiragana", "TylorShine/distilhubert-hiragana-ctc",
     "01ffc3e5b0e49ba34180d50c48ea4111aa041cfd", "dual"),
    ("wavlm-base-plus-hiragana-v2", "TylorShine/wavlm-base-plus-hiragana-ctc-v2",
     "cb9ad2c5e0b8722df153334349d85b3322b1cb91", "dual"),
    ("wav2vec2-large-xlsr-hiragana", "vumichien/wav2vec2-large-xlsr-japanese-hiragana",
     "017225bb128a6b1c6de9d58391f891908d69bc7b", "ctc"),
]


def normalize_kana(s):
    """Mirror of normalizeKana in src/shared/normalize.js."""
    s = unicodedata.normalize("NFKC", s)
    s = "".join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in s)
    s = "".join(c for c in s if not (c.isspace() or c in "、。，．,.!?！？「」『』・…〜~'\"-"))
    ok = bool(s) and all(0x3041 <= ord(c) <= 0x3096 or c in "ゝゞー" for c in s)
    return s if ok else None


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def greedy(ids, blank, decode):
    out, prev = [], None
    for i in ids:
        if i != blank and i != prev:
            out.append(i)
        prev = i
    return decode(out)


def load(repo, revision, kind):
    if kind == "dual":
        model = AutoModel.from_pretrained(repo, revision=revision, trust_remote_code=True).eval()
        try:
            fe = AutoFeatureExtractor.from_pretrained(repo, revision=revision)
        except Exception:  # some repos ship no preprocessor config
            fe = None
        tok = PreTrainedTokenizerFast.from_pretrained(repo, revision=revision, subfolder="kana_tokenizer")

        def run(audio):
            x = fe(audio, sampling_rate=16000, return_tensors="pt").input_values if fe else \
                torch.from_numpy(audio)[None]
            logits = model(x)["kana_logits"][0]
            return greedy(logits.argmax(-1).tolist(), tok.pad_token_id,
                          lambda ids: tok.decode(ids).replace(" ", ""))
        return run
    proc = AutoProcessor.from_pretrained(repo, revision=revision)
    model = AutoModelForCTC.from_pretrained(repo, revision=revision).eval()

    def run(audio):
        x = proc(audio, sampling_rate=16000, return_tensors="pt").input_values
        logits = model(x).logits[0]
        return proc.decode(logits.argmax(-1).tolist())
    return run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="real-raw")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    words = json.loads((ROOT / "tools/recorder/words.json").read_text(encoding="utf-8"))["ja"]
    torch.set_num_threads(4)
    for name, repo, rev, kind in CANDIDATES:
        if args.only and args.only not in name:
            continue
        run = load(repo, rev, kind)
        hits, misses, total = 0, [], 0.0
        with torch.inference_mode():
            for w in words:
                audio = read_wav(ROOT / "test/fixtures/audio" / args.set / "ja" / f"{w['slug']}.wav")
                t0 = time.perf_counter()
                raw = run(audio)
                total += time.perf_counter() - t0
                got = normalize_kana(raw)
                if got == w["expected"]:
                    hits += 1
                else:
                    misses.append(f"{w['expected']}→{got or repr(raw)}")
        print(f"{name:30} {hits}/{len(words)}  mean {1000 * total / len(words):.0f} ms  | {', '.join(misses)}")


if __name__ == "__main__":
    main()
