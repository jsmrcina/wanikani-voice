"""Local recording page for evaluation clips (dev tool; nothing leaves the machine).

    python3 tools/recorder/server.py [--port 8765] [--set real] [--words FILE]
then open http://localhost:8765/ in Firefox and allow the microphone.

Serves the repository read-only (the page reuses src/content/audio.js, the
extension's own capture code) and accepts clip uploads, written to
personal/fixtures/<set>/<lang>/<slug>.wav (16 kHz mono PCM16; personal/ is
the private submodule); use a new
--set for each recording condition (e.g. real = through a system noise filter,
real-raw = raw microphone) so takes can be compared. With --words (a personal list,
e.g. from tools/wk-readings.py) and --set personal, clips go to
personal/recordings/ instead, which is git-ignored.
"""
import argparse
import http.server
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "personal/fixtures/real"  # replaced by --set
WORDS = None  # set in main from --words
SET = "real"
VALID = set()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.path = "/tools/recorder/index.html"
        if self.path == "/status":
            done = sorted(f"{p.parent.name}/{p.stem}" for p in OUT.glob("*/*.wav"))
            return self._json({"words": WORDS, "recorded": done, "set": SET})
        return super().do_GET()

    def do_POST(self):
        m = re.fullmatch(r"/save/(en|ja|noise)/([A-Za-z0-9-]+)", self.path)
        if not m or (m[1], m[2]) not in VALID:
            return self._json({"error": "unknown clip"}, 400)
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if body[:4] != b"RIFF" or body[8:12] != b"WAVE" or len(body) > 2_000_000:
            return self._json({"error": "not a small WAV"}, 400)
        path = OUT / m[1] / f"{m[2]}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return self._json({"saved": str(path.relative_to(ROOT))})

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--set", default="real")
    ap.add_argument("--words", default=str(ROOT / "tools/recorder/words.json"))
    a = ap.parse_args()
    port = a.port
    WORDS = json.loads(Path(a.words).read_text(encoding="utf-8"))
    VALID = {(lang, w["slug"]) for lang in ("en", "ja", "noise") for w in WORDS[lang]}
    SET = a.set
    OUT = (ROOT / "personal/recordings") if a.set == "personal" else (ROOT / "personal/fixtures" / a.set)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Recorder: http://localhost:{port}/  (Ctrl+C to stop)")
    server.serve_forever()
