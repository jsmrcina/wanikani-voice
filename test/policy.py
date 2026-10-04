"""Static checks for the privacy and "don't read the question" rules.

Run directly (python3 test/policy.py) or via test/run_tests.py.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# Only these content modules may query WaniKani's DOM.
PAGE_ACCESS_ALLOWED = {"page-reader.js", "answer-io.js"}
PAGE_ACCESS = re.compile(
    r"document\s*\.\s*(querySelector|querySelectorAll|getElementBy\w+|getElementsBy\w+|body|forms|all|evaluate)\b"
)
# Selectors for the question itself, item info, or answer data. No module uses them.
QUESTION_SELECTORS = re.compile(
    r"character-header|characters|additional-content|item-info|subject-info|"
    r"quiz-user-synonyms|wkof|application/json"
)
# Event payloads (e.g. willShowNextQuestion's detail) describe the subject.
EVENT_DETAIL = re.compile(r"\.detail\b")
NETWORK = re.compile(
    r"\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|https?://"
)
# URLs allowed to appear in source (none are fetched).
URL_ALLOWLIST = ("https://www.wanikani.com/", "http://www.w3.org/2000/svg")


def strip_comments(js: str) -> str:
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    return re.sub(r"(^|[^:])//.*", r"\1", js)


def check() -> list[str]:
    problems = []
    for path in sorted(SRC.rglob("*.js")):
        rel = path.relative_to(ROOT)
        code = strip_comments(path.read_text(encoding="utf-8"))
        in_content = path.parent.name == "content"
        if in_content and path.name not in PAGE_ACCESS_ALLOWED and PAGE_ACCESS.search(code):
            problems.append(f"{rel}: queries the page; only {sorted(PAGE_ACCESS_ALLOWED)} may")
        if in_content and QUESTION_SELECTORS.search(code):
            problems.append(f"{rel}: references question/item content: {QUESTION_SELECTORS.search(code).group(0)}")
        if in_content and EVENT_DETAIL.search(code):
            problems.append(f"{rel}: reads an event payload (.detail)")
        for m in NETWORK.finditer(code):
            text = code[m.start(): m.start() + 60]
            if not text.startswith(URL_ALLOWLIST):
                problems.append(f"{rel}: network/URL use: {text.splitlines()[0]}")

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    hosts = manifest.get("host_permissions", [])
    for cs in manifest.get("content_scripts", []):
        hosts += cs.get("matches", [])
    for h in hosts:
        if not h.startswith("https://www.wanikani.com/"):
            problems.append(f"manifest.json: host access beyond WaniKani: {h}")
    gecko = manifest["browser_specific_settings"]["gecko"]
    if gecko.get("data_collection_permissions", {}).get("required") != ["none"]:
        problems.append("manifest.json: data_collection_permissions must declare none")
    return problems


if __name__ == "__main__":
    found = check()
    for p in found:
        print("POLICY:", p)
    print(f"policy: {'FAIL' if found else 'ok'}")
    sys.exit(1 if found else 0)
