"""Fine-tunes Moonshine base, the default ("fast") English model, on your own
recorded WaniKani meanings, so it learns how *you* say them. The result is a
personal model, loaded as a custom model in the settings (never published).

Dev-time only (torch + transformers; runs on a CPU in minutes):
    python tools/finetune-moonshine.py [--epochs 12] [--lr 1e-5]
        [--out personal/models/moonshine-base-ft] [--device cuda]
then export it for the extension:
    python tools/export-moonshine.py personal/models/moonshine-base-ft

- Training data: the "train" split of the English list in personal/words.json
  (tools/wk-meanings.mjs), recorded into personal/recordings/en. 10% of it is
  held out to pick the best epoch. The "test" split is never trained on:
  score it afterwards with tools/eval-asr.mjs --personal (on the exported
  ONNX model, so through exactly the extension's decoding).
- --all (for the final model, once a held-out run has shown how many epochs
  to train): trains on every recording, train and test splits, for exactly
  --epochs, with no validation (2026-10-06: 2 epochs, the best on held-out
  clips; later ones overfit).
- Benchmark: the raw evaluation recordings (personal/fixtures/real-raw/en,
  different words, recorded on another day), scored before and after as a
  check that the model still generalises.
- Targets are the meanings as WaniKani writes them ("North Country").
- Trains everything except the convolutional stem of the encoder (too little
  data to retrain how raw audio is turned into features).
- The loss is computed here, not by the model: transformers 4.57 gives
  Moonshine a causal-LM loss that shifts the labels a second time (found
  2026-10-06: 10.7 on a clip the model gets right, 0.21 when computed
  correctly), which trains it to predict the token after next.
"""
import argparse
import json
import random
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import AutoTokenizer, MoonshineForConditionalGeneration

ROOT = Path(__file__).resolve().parent.parent
REPO = "moonshine-ai/moonshine-base"  # formerly UsefulSensors/moonshine-base
REVISION = "7a73d8d55ac0ba2ef3ae761593f6784b51f96dcf"
START, EOS = 1, 2  # decoder start; end of text (also Moonshine's padding token)
FROZEN = ("model.encoder.conv1", "model.encoder.conv2", "model.encoder.conv3", "model.encoder.groupnorm")


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def augment(audio, rng):
    # Speed ±10% (resampling), gain ±6 dB, low noise, up to 150 ms shift
    # (the same as tools/finetune-hiragana.py).
    rate = rng.uniform(0.9, 1.1)
    idx = np.arange(0, len(audio) - 1, rate)
    audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    audio *= 10 ** (rng.uniform(-6, 6) / 20)
    audio += rng.normal(0, 10 ** (rng.uniform(-60, -45) / 20), len(audio)).astype(np.float32)
    shift = int(rng.uniform(0, 0.15) * 16000)
    return np.concatenate([np.zeros(shift, np.float32), audio]) if rng.random() < 0.5 else audio[shift:]


def simple_norm(text):
    """Rough stand-in for the extension's English normaliser, for picking the
    best epoch (the final score comes from tools/eval-asr.mjs)."""
    text = re.sub(r"[-‐–]", " ", text.lower())
    text = re.sub(r"[^a-z0-9' ]", "", text)
    return " ".join(text.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", default="personal/words.json")
    ap.add_argument("--clips", default="personal/recordings")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--out", default="personal/models/moonshine-base-ft")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--all", action="store_true", help="train on every recording for exactly --epochs")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    random.seed(args.seed)
    torch.manual_seed(args.seed)

    src = Path(snapshot_download(REPO, revision=REVISION))
    tok = AutoTokenizer.from_pretrained(src)
    model = MoonshineForConditionalGeneration.from_pretrained(src).to(args.device)

    words = json.loads((ROOT / args.words).read_text(encoding="utf-8"))["en"]
    data = [(ROOT / args.clips / "en" / f"{w['slug']}.wav", w["say"]) for w in words
            if args.all or w.get("split") == "train"]
    data = [d for d in data if d[0].exists()]
    if len(data) < 50:
        sys.exit(f"only {len(data)} training recordings; record more first (tools/recorder)")
    random.shuffle(data)
    n_val = 0 if args.all else max(10, len(data) // 10)
    val, train = data[:n_val], data[n_val:]
    bench_words = json.loads((ROOT / "tools/recorder/words.json").read_text(encoding="utf-8"))["en"]
    bench = [(ROOT / "personal/fixtures/real-raw/en" / f"{w['slug']}.wav", w["say"]) for w in bench_words]
    bench = [b for b in bench if b[0].exists()]
    print(f"train {len(train)}, validation {len(val)}, benchmark {len(bench)} (never trained on); device {args.device}")

    for name, p in model.named_parameters():
        p.requires_grad = not name.startswith(FROZEN)
    params = [p for p in model.parameters() if p.requires_grad]
    print(f"training {sum(p.numel() for p in params) / 1e6:.1f}M of "
          f"{sum(p.numel() for p in model.parameters()) / 1e6:.1f}M weights")
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)

    def labels_for(text):
        return tok(text).input_ids[1:] + [EOS]  # drop the start token; the model adds it

    @torch.inference_mode()
    def score(items):
        model.eval()
        hits = 0
        for wav, text in items:
            audio = read_wav(wav)
            x = torch.from_numpy(audio)[None].to(args.device)
            limit = min(24, max(8, int(np.ceil(len(audio) / 16000 * 6.5))))  # as in the extension
            ids = model.generate(x, max_new_tokens=limit, min_new_tokens=1)
            hits += simple_norm(tok.decode(ids[0], skip_special_tokens=True)) == simple_norm(text)
        return hits

    best = score(val)
    print(f"before: validation {best}/{len(val)}, benchmark {score(bench)}/{len(bench)}", flush=True)
    if args.all:
        best = -1  # no validation: keep the last epoch
    out = (ROOT / args.out).resolve()
    ckpt = out / "checkpoint"
    ckpt.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(ckpt)
    tok.save_pretrained(ckpt)
    for epoch in range(1, args.epochs + 1):
        model.train()
        for name, module in model.named_modules():
            if name.startswith(FROZEN):
                module.eval()
        random.shuffle(train)
        t0, total = time.time(), 0.0
        for i in range(0, len(train), args.batch):
            batch = train[i:i + args.batch]
            audios = [augment(read_wav(w), rng) for w, _ in batch]
            length = max(len(a) for a in audios)
            x = torch.zeros(len(audios), length)
            mask = torch.zeros(len(audios), length, dtype=torch.long)
            for j, a in enumerate(audios):
                x[j, :len(a)] = torch.from_numpy(a)
                mask[j, :len(a)] = 1
            targets = [labels_for(t) for _, t in batch]
            width = max(map(len, targets))
            labels = torch.full((len(batch), width), -100, dtype=torch.long)
            decoder_in = torch.full((len(batch), width), EOS, dtype=torch.long)
            for j, t in enumerate(targets):
                labels[j, :len(t)] = torch.tensor(t)
                decoder_in[j, :len(t)] = torch.tensor([START] + t[:-1])  # teacher forcing
            logits = model(x.to(args.device), attention_mask=mask.to(args.device),
                           decoder_input_ids=decoder_in.to(args.device)).logits
            loss = torch.nn.functional.cross_entropy(logits.flatten(0, 1), labels.to(args.device).flatten(),
                                                     ignore_index=-100)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            total += loss.item() * len(batch)
        v = score(val)
        print(f"epoch {epoch:3}: loss {total / len(train):.3f}  validation {v}/{len(val)}  ({time.time() - t0:.0f} s)", flush=True)
        if v > best or args.all:
            best = v
            model.save_pretrained(ckpt)
    model = MoonshineForConditionalGeneration.from_pretrained(ckpt).to(args.device)
    print(f"best: validation {best}/{len(val)}, benchmark {score(bench)}/{len(bench)}")
    print(f"checkpoint: {ckpt}\nexport:     python tools/export-moonshine.py {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
