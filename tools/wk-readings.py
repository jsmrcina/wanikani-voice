"""Builds a personal recording list from the readings of your unlocked
WaniKani kanji and vocabulary, for fine-tuning the hiragana model on your
voice (PLAN.md, Phase 4).

Dev-time only. The extension itself never calls the WaniKani API.

    python3 tools/wk-readings.py [--max 400] [--seed 1]

By default 75% of the list has the hard sounds and 25% is ordinary readings.

Needs a read-only WaniKani API token (https://www.wanikani.com/settings/personal_access_tokens)
in ~/.config/wanikani-voice/api-token. Writes personal/words.json (the private submodule),
in the recorder's format, for:
    python3 tools/recorder/server.py --words personal/words.json --set personal
"""
import argparse
import json
import random
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = Path.home() / ".config/wanikani-voice/api-token"
API = "https://api.wanikani.com/v2"
# Sounds the generic model gets wrong most (PLAN.md S4): small ゃゅょ, っ,
# long vowels, the r-row. Readings with them are always kept.
HARD = re.compile(r"[ゃゅょっらりるれろ]|[おこそとのほもよろごぞどぼぽょ]う|[えけせてねへめれげぜでべぺ]い|ー")


def get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Wanikani-Revision": "20170710"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def paged(url, token):
    while url:
        page = get(url, token)
        yield from page["data"]
        url = page["pages"]["next_url"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--seed", type=int, default=1)
    # Mostly hard sounds, but enough ordinary readings that the model doesn't
    # drift on plain words.
    ap.add_argument("--hard-share", type=float, default=0.75)
    args = ap.parse_args()
    token = TOKEN_FILE.read_text().strip()

    subject_ids = [a["data"]["subject_id"] for a in paged(
        f"{API}/assignments?unlocked=true&subject_types=kanji,vocabulary", token)]
    print(f"{len(subject_ids)} unlocked kanji/vocabulary")

    readings = {}  # reading -> {say, hint, slug}
    for i in range(0, len(subject_ids), 500):
        ids = ",".join(map(str, subject_ids[i:i + 500]))
        for s in paged(f"{API}/subjects?ids={ids}", token):
            for n, r in enumerate(s["data"].get("readings", [])):
                reading = r["reading"]
                if not r["accepted_answer"] or reading in readings:
                    continue
                if not re.fullmatch(r"[ぁ-ゖー]+", reading):
                    continue
                readings[reading] = {"slug": f"wk{s['id']}-{n}", "say": reading,
                                     "hint": s["data"]["characters"], "expected": reading}
    words = list(readings.values())
    hard = [w for w in words if HARD.search(w["say"])]
    rest = [w for w in words if not HARD.search(w["say"])]
    rng = random.Random(args.seed)
    n_hard = min(len(hard), round(args.max * args.hard_share))
    n_rest = min(len(rest), args.max - n_hard)
    chosen = rng.sample(hard, n_hard) + rng.sample(rest, n_rest)
    chosen.sort(key=lambda w: w["slug"])
    print(f"{len(words)} distinct readings ({len(hard)} with hard sounds); keeping {len(chosen)}")

    out = ROOT / "personal/words.json"
    out.parent.mkdir(exist_ok=True)
    # Keep the English list (tools/wk-meanings.mjs) if there is one.
    existing = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    out.write_text(json.dumps({
        "comment": "Personal lists from your unlocked WaniKani items: readings (tools/wk-readings.py) "
                   "and meanings (tools/wk-meanings.mjs).",
        "en": existing.get("en", []), "noise": existing.get("noise", []), "ja": chosen,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
