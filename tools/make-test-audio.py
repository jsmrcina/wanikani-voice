"""Generates synthetic speech fixtures for recognizer tests (dev-time only).

Needs `piper` (pip install piper-tts), Piper voice files, and ffmpeg:
    python3 tools/make-test-audio.py --voices DIR [--piper PATH]
Writes test/fixtures/audio/en/<voice>/<slug>.wav (16 kHz mono, padded with
silence and light noise) and test/fixtures/audio/en/manifest.json, which maps
each clip to the text an ideal recognizer should produce after normalisation.
Synthetic voices are a stand-in; real recordings belong alongside them.
"""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test/fixtures/audio/en"
VOICES = ["en_US-lessac-medium", "en_US-ryan-medium", "en_GB-alba-medium"]

# (spoken text, expected normalised answer)
PHRASES = [
    ("Fire", "fire"), ("Water", "water"), ("Person", "person"), ("Mouth", "mouth"),
    ("Big", "big"), ("Small", "small"), ("Mountain", "mountain"), ("Tree", "tree"),
    ("Rice field", "rice field"), ("Power", "power"), ("Middle", "middle"),
    ("Inside", "inside"), ("Above", "above"), ("Below", "below"), ("Sun", "sun"),
    ("Moon", "moon"), ("Eye", "eye"), ("Hand", "hand"), ("Foot", "foot"),
    ("King", "king"), ("Jewel", "jewel"), ("Stop", "stop"), ("Correct", "correct"),
    ("White", "white"), ("Craft", "craft"), ("Spoon", "spoon"), ("Barb", "barb"),
    ("Lid", "lid"), ("Ground", "ground"), ("Drop", "drop"), ("Fins", "fins"),
    ("Stick", "stick"), ("Turtle", "turtle"), ("Pirate", "pirate"),
    ("To eat", "to eat"), ("One person", "one person"), ("Four", "four"),
    ("Ten", "ten"), ("Twenty one", "21"), ("Ten thousand", "10000"),
    ("Hundred", "100"), ("Three people", "three people"), ("Grown up", "grown up"),
    ("Big brother", "big brother"), ("Outside", "outside"), ("Before", "before"),
]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", required=True, type=Path)
    ap.add_argument("--piper", default="piper")
    args = ap.parse_args()
    manifest = []
    with tempfile.TemporaryDirectory() as tmp:
        for voice in VOICES:
            (OUT / voice).mkdir(parents=True, exist_ok=True)
            for text, expected in PHRASES:
                raw = Path(tmp) / "raw.wav"
                subprocess.run([args.piper, "-m", str(args.voices / f"{voice}.onnx"), "-f", str(raw)],
                               input=text.encode(), check=True, capture_output=True)
                rel = f"{voice}/{slug(text)}.wav"
                # 16 kHz mono; 0.4 s silence before, 0.6 s after; pink noise at -50 dB.
                subprocess.run([
                    "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
                    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.003:sample_rate=16000",
                    "-filter_complex",
                    "[0:a]aresample=16000,adelay=400:all=1,apad=pad_dur=0.6[s];[s][1:a]amix=inputs=2:duration=first:normalize=0",
                    "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(OUT / rel)], check=True)
                manifest.append({"file": rel, "said": text, "expected": expected})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{len(manifest)} clips")


if __name__ == "__main__":
    main()
