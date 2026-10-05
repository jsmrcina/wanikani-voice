"""Fine-tunes the hiragana model (distilhubert-hiragana-ctc) on your own
recorded readings, so it learns how *you* say りょ, せいおう, etc. (PLAN.md,
Phase 4). The result is a personal model for your own build only.

Dev-time only (torch + transformers; a CUDA GPU makes it take minutes):
    python tools/finetune-hiragana.py [--data personal/words.json:personal/recordings ...]
        [--epochs 30] [--out personal/models/distilhubert-hiragana] [--device cuda]

- Training data: each --data pair is a recorder word list and the folder its
  clips were saved to (default: the personal list from tools/wk-readings.py).
  10% is held out for validation.
- Benchmark: the raw evaluation readings (personal/fixtures/real-raw/ja) are
  never trained on; they're scored before and after, like eval-asr's first
  choice (greedy decode + the extension's normalisation rules).
- Trains the transformer layers and kana CTC head; the convolutional feature
  encoder stays frozen (too little data to retrain it). Targets are the
  readings as WaniKani spells them (きょう, not きょー).
- Saves the best checkpoint by validation exact-match, then exports it with
  the same ONNX conversion and quantisation as the shipped model.
"""
import argparse
import importlib.util
import json
import random
import sys
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import AutoModel, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parent.parent
REPO = "TylorShine/distilhubert-hiragana-ctc"
REVISION = "01ffc3e5b0e49ba34180d50c48ea4111aa041cfd"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def collect(pairs):
    items = []
    for pair in pairs:
        words_file, folder = pair.split(":")
        words = json.loads(Path(words_file).read_text(encoding="utf-8"))["ja"]
        for w in words:
            wav = Path(folder) / "ja" / f"{w['slug']}.wav"
            if wav.exists():
                items.append((wav, w["expected"]))
    return items


def augment(audio, rng):
    # Speed ±10% (resampling), gain ±6 dB, low noise, up to 150 ms shift.
    rate = rng.uniform(0.9, 1.1)
    idx = np.arange(0, len(audio) - 1, rate)
    audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    audio *= 10 ** (rng.uniform(-6, 6) / 20)
    audio += rng.normal(0, 10 ** (rng.uniform(-60, -45) / 20), len(audio)).astype(np.float32)
    shift = int(rng.uniform(0, 0.15) * 16000)
    return np.concatenate([np.zeros(shift, np.float32), audio]) if rng.random() < 0.5 else audio[shift:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="+", default=["personal/words.json:personal/recordings"])
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--out", default="personal/models/distilhubert-hiragana")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--seed", type=int, default=1)
    # Train only the kana head (LayerNorm + 2 linear layers, ~0.65M weights),
    # the part that could be trained inside the extension in plain JS. Used to
    # compare against full fine-tuning before building that.
    ap.add_argument("--head-only", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    random.seed(args.seed)
    torch.manual_seed(args.seed)

    ev = load_module("eval_ja_torch", ROOT / "tools/eval-ja-torch.py")
    src = Path(snapshot_download(REPO, revision=REVISION))
    model = AutoModel.from_pretrained(src, trust_remote_code=True).to(args.device)
    tok = PreTrainedTokenizerFast.from_pretrained(src, subfolder="kana_tokenizer")
    blank = tok.pad_token_id
    vocab = {i: t for t, i in tok.get_vocab().items()}

    def encode(text):
        ids = [tok.convert_tokens_to_ids(ch) for ch in text]
        if any(i is None or i == tok.unk_token_id for i in ids):
            return None
        return ids

    def expand(text):  # the extension's ー convention, for scoring
        out = ev.normalize_kana(text)
        return out

    data = [(w, t, encode(t)) for w, t in collect(args.data)]
    skipped = [t for _, t, ids in data if ids is None]
    data = [d for d in data if d[2] is not None]
    if skipped:
        print(f"skipped {len(skipped)} readings with characters outside the model's vocabulary: {skipped[:10]}")
    if len(data) < 20:
        sys.exit(f"only {len(data)} usable recordings; record more first")
    random.shuffle(data)
    n_val = max(5, len(data) // 10)
    val, train = data[:n_val], data[n_val:]
    bench_words = json.loads((ROOT / "tools/recorder/words.json").read_text(encoding="utf-8"))["ja"]
    bench = [(ROOT / "personal/fixtures/real-raw/ja" / f"{w['slug']}.wav", w["expected"]) for w in bench_words]
    print(f"train {len(train)}, validation {len(val)}, benchmark {len(bench)} (never trained on); device {args.device}")

    # Freeze the convolutional feature encoder (or, with --head-only, the whole
    # encoder); train the rest.
    for name, p in model.named_parameters():
        frozen = name.startswith("encoder.") if args.head_only else name.startswith("encoder.feature_extractor")
        p.requires_grad = not frozen
    print(f"training {sum(p.numel() for p in model.parameters() if p.requires_grad) / 1e6:.2f}M weights"
          + (" (kana head only)" if args.head_only else ""))
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    ctc = torch.nn.CTCLoss(blank=blank, zero_infinity=True)

    @torch.inference_mode()
    def score(items):
        model.eval()
        hits = 0
        for wav, text, *_ in items:
            x = torch.from_numpy(read_wav(wav))[None].to(args.device)
            ids = model(x)["kana_logits"][0].argmax(-1).tolist()
            got = ev.greedy(ids, blank, lambda seq: "".join(vocab[i] for i in seq))
            hits += expand(got) == text
        return hits

    best = score(val)
    print(f"before: validation {best}/{len(val)}, benchmark {score(bench)}/{len(bench)}")
    out = (ROOT / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    ckpt = out / "checkpoint"
    model.save_pretrained(ckpt)
    for epoch in range(1, args.epochs + 1):
        model.train()
        model.encoder.feature_extractor.eval()
        if args.head_only:
            model.encoder.eval()  # no dropout in the frozen encoder
        random.shuffle(train)
        t0, total = time.time(), 0.0
        for i in range(0, len(train), args.batch):
            batch = train[i:i + args.batch]
            audios = [augment(read_wav(w), rng) for w, _, _ in batch]
            length = max(len(a) for a in audios)
            x = torch.zeros(len(audios), length)
            mask = torch.zeros(len(audios), length, dtype=torch.long)
            for j, a in enumerate(audios):
                x[j, :len(a)] = torch.from_numpy(a)
                mask[j, :len(a)] = 1
            x, mask = x.to(args.device), mask.to(args.device)
            # Group-norm HuBERT: zero-pad, no attention mask (as HF advises).
            logits = model(x)["kana_logits"]
            log_probs = logits.log_softmax(-1).transpose(0, 1)  # T, B, V
            in_lens = model.get_feat_extract_output_lengths(mask.sum(-1))
            targets = torch.tensor([t for _, _, ids in batch for t in ids], device=args.device)
            tgt_lens = torch.tensor([len(ids) for _, _, ids in batch], device=args.device)
            loss = ctc(log_probs, targets, in_lens, tgt_lens)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 5.0)
            opt.step()
            total += loss.item() * len(batch)
        v = score(val)
        print(f"epoch {epoch:3}: loss {total / len(train):.3f}  validation {v}/{len(val)}  ({time.time() - t0:.0f} s)")
        if v > best:
            best = v
            model.save_pretrained(ckpt)
    model = AutoModel.from_pretrained(ckpt, trust_remote_code=True).to(args.device)
    print(f"best: validation {best}/{len(val)}, benchmark {score(bench)}/{len(bench)}")
    # Copy the tokenizer folders next to the checkpoint so the export finds them.
    for sub in ("kana_tokenizer", "phoneme_tokenizer"):
        for f in (src / sub).glob("*"):
            (ckpt / sub).mkdir(exist_ok=True)
            (ckpt / sub / f.name).write_bytes(f.read_bytes())
    print(f"checkpoint: {ckpt}\n"
          f"export:     python tools/export-dual-ctc.py {ckpt} - {out}")


if __name__ == "__main__":
    main()
