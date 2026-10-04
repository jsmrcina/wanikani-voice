"""Runs all tests: static policy checks, unit tests and end-to-end tests in a
real (headless) Firefox with the extension installed against test/mock.

Needs: Python with `selenium`, and `geckodriver` on PATH or in $GECKODRIVER.
    python3 test/run_tests.py [-k name-substring] [--headed]
"""
import argparse
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.service import Service

sys.path.insert(0, str(Path(__file__).parent))
import policy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ADDON_ID = "wanikani-voice@jsmrcina"
ADDON_UUID = "6f1e0c52-3a8b-4c7e-9d41-2b5a7e9c0d11"


# ---- local server ------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    ROUTES = {"/subjects/review": "test/mock/review.html", "/elsewhere": "test/unit/index.html"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def translate_path(self, path):
        clean = path.split("?")[0].rstrip("/")
        if clean in self.ROUTES:
            return str(ROOT / self.ROUTES[clean])
        return super().translate_path(path)

    def log_message(self, *a):
        pass


def start_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://localhost:{server.server_address[1]}"


# ---- extension test build -----------------------------------------------------

def build_test_extension() -> Path:
    """Copy of the extension that also runs on http://localhost, with the
    indicator's shadow root open so the test can type into its test field."""
    out = Path(tempfile.mkdtemp(prefix="wkv-ext-"))
    for name in ("manifest.json", "src", "icons"):
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, out / name)
        else:
            shutil.copy(src, out / name)
    manifest = json.loads((out / "manifest.json").read_text())
    manifest["host_permissions"].append("http://localhost/*")
    manifest["content_scripts"][0]["matches"].append("http://localhost/*")
    # WebDriver can't drive moz-extension:// pages, so tests set settings
    # through a bridge content script that only exists in this build.
    shutil.copy(ROOT / "test/hooks/settings-bridge.js", out / "settings-bridge.js")
    manifest["content_scripts"].append(
        {"matches": ["http://localhost/*"], "js": ["settings-bridge.js"], "run_at": "document_start"})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    ind = out / "src/content/indicator.js"
    ind.write_text(ind.read_text().replace("mode: 'closed'", "mode: 'open'"))
    return out


# ---- browser helpers ----------------------------------------------------------

class Browser:
    def __init__(self, base, ext_dir, headed=False):
        self.base = base
        opts = webdriver.FirefoxOptions()
        if not headed:
            opts.add_argument("-headless")
        opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: ADDON_UUID}))
        service = Service(executable_path=os.environ.get("GECKODRIVER") or shutil.which("geckodriver"))
        self.d = webdriver.Firefox(options=opts, service=service)
        self.d.install_addon(str(ext_dir), temporary=True)

    def quit(self):
        self.d.quit()

    def wait(self, fn, timeout=4.0, what="condition"):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            try:
                last = fn()
                if last:
                    return last
            except Exception as e:  # element not there yet, etc.
                last = e
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what} (last: {last!r})")

    def settings(self, replace=None):
        """Reads (and optionally replaces) the extension's stored settings."""
        if not self.d.current_url.startswith(self.base):
            self.d.get(self.base + "/elsewhere")
        return self.d.execute_async_script("""
            const [replace, done] = arguments;
            const id = Math.random();
            window.addEventListener('message', function on(e) {
              if (e.data?.type === 'wkv-test:settings-result' && e.data.id === id) {
                window.removeEventListener('message', on); done(e.data.stored);
              }
            });
            window.postMessage({ type: 'wkv-test:settings', id, replace }, '*');""", replace)

    def set_options(self, **settings):
        self.d.get(self.base + "/elsewhere")
        self.settings(replace=settings)

    def open_review(self):
        self.d.get(self.base + "/subjects/review/")
        self.wait(lambda: self.state() not in (None, "off", "unsupported"), what="indicator ready")

    def host(self):
        return self.d.find_element(By.CSS_SELECTOR, "wkv-indicator")

    def state(self):
        els = self.d.find_elements(By.CSS_SELECTOR, "wkv-indicator")
        return els[0].get_attribute("data-state") if els else None

    def mode(self):
        return self.host().get_attribute("data-mode")

    def wait_state(self, *states, timeout=4.0):
        return self.wait(lambda: self.state() in states and self.state(), timeout,
                         f"state in {states}")

    def input_value(self):
        return self.d.find_element(By.ID, "user-response").get_attribute("value")

    def mock_log(self):
        return json.loads(self.d.find_element(By.ID, "mock-log").text or "[]")

    def set_utterance(self, text):
        field = self.host().shadow_root.find_element(By.CSS_SELECTOR, ".dev input")
        field.clear()
        if text:
            field.send_keys(text)
        return field

    def say(self, text, key=Keys.SHIFT):
        """Push-to-talk: type the stand-in utterance, then hold and release the key."""
        self.set_utterance(text)
        self.d.find_element(By.ID, "user-response").click()
        ActionChains(self.d).key_down(key).pause(0.3).key_up(key).perform()

    def say_hands_free(self, text):
        self.set_utterance(text).send_keys(Keys.ENTER)

    def press_enter(self):
        ActionChains(self.d).send_keys(Keys.ENTER).perform()


# ---- tests --------------------------------------------------------------------

def test_unit(b):
    b.d.get(b.base + "/test/unit/index.html")
    res = json.loads(b.wait(lambda: (t := b.d.find_element(By.ID, "results").text) != "running" and t,
                            what="unit results"))
    assert not res["failures"], json.dumps(res["failures"], ensure_ascii=False, indent=1)
    return f"{res['total']} cases"


def test_inactive_off_review_page(b):
    b.set_options()
    b.d.get(b.base + "/elsewhere")
    time.sleep(0.5)
    assert b.state() is None, "indicator should not appear outside /subjects/review"


def test_defaults_fill_only_push_to_talk(b):
    b.set_options()
    b.open_review()
    assert b.state() == "ready" and b.mode() == "en", (b.state(), b.mode())

    b.say("Fire.")
    b.wait_state("filled")
    assert b.input_value() == "fire", b.input_value()
    time.sleep(0.4)
    assert b.mock_log() == [], f"fill-only must not submit: {b.mock_log()}"

    b.press_enter()  # the user submits
    b.wait(lambda: b.mock_log(), what="submission")
    assert b.mock_log()[-1] == {"index": 0, "answer": "fire", "pass": True}
    b.wait_state("waiting")
    time.sleep(2.0)  # auto-advance is off by default
    assert b.state() == "waiting"

    b.press_enter()  # the user advances
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", what="reading question")
    b.say("ジン")
    b.wait_state("filled")
    assert b.input_value() == "じん", b.input_value()


def test_wrong_answer_not_corrected(b):
    b.set_options(submitMode="auto-submit")
    b.open_review()
    b.say("water")  # the radical is "fire"; must go in exactly as said
    b.wait(lambda: b.mock_log(), what="submission")
    assert b.mock_log()[-1] == {"index": 0, "answer": "water", "pass": False}


def test_auto_submit_and_advance(b):
    b.set_options(submitMode="auto-submit", autoAdvance=True, autoAdvanceDelayMs=300)
    b.open_review()
    b.say("fire")
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", what="auto-advanced")
    b.say("じん")
    b.wait(lambda: b.mode() == "en" and len(b.mock_log()) == 2, what="second answer")
    b.say("4")  # Kanji meaning "four": numbers up to ten become words
    b.wait(lambda: len(b.mock_log()) == 3, what="third answer")
    b.wait(lambda: b.state() == "ready" and len(b.mock_log()) == 3, what="vocab question")
    b.say("twenty")
    b.wait(lambda: len(b.mock_log()) == 4, what="fourth answer")
    assert [e["answer"] for e in b.mock_log()] == ["fire", "じん", "four", "20"], b.mock_log()
    assert all(e["pass"] for e in b.mock_log())


def test_kanji_rejected_for_reading(b):
    b.set_options(submitMode="auto-submit", autoAdvance=True, autoAdvanceDelayMs=200)
    b.open_review()
    b.say("fire")
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", what="reading question")
    b.say("人")
    b.wait_state("error")
    assert b.input_value() == "", "kanji must not be filled in"
    assert len(b.mock_log()) == 1
    b.wait_state("ready", timeout=4)


def test_hands_free(b):
    b.set_options(inputMode="voice-activity", submitMode="auto-submit",
                  autoAdvance=True, autoAdvanceDelayMs=200)
    b.open_review()
    assert b.state() == "listening", b.state()
    b.say_hands_free("fire")
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "listening", what="listening on next question")
    b.say_hands_free("じん")
    b.wait(lambda: len(b.mock_log()) == 2, what="second answer")


def test_pause_toggle(b):
    b.set_options()
    b.open_review()
    badge = lambda: b.host().shadow_root.find_element(By.CSS_SELECTOR, ".badge")
    badge().click()
    b.wait_state("off")
    b.say("fire")
    time.sleep(0.3)
    assert b.state() == "off" and b.input_value() == "", "paused: PTT does nothing"
    badge().click()
    b.wait_state("ready")


def test_options_page_saves(b):
    # The real options markup and script, on a plain page with in-memory storage.
    b.d.get(b.base + "/test/options/index.html")
    b.wait(lambda: b.d.find_element(By.ID, "pttKey").text == "Shift", what="options rendered")
    assert b.d.find_element(By.CSS_SELECTOR, 'input[value="push-to-talk"]').is_selected()
    assert b.d.find_element(By.CSS_SELECTOR, 'input[value="fill-only"]').is_selected()
    assert not b.d.find_element(By.ID, "autoAdvance").is_selected()
    assert b.d.find_element(By.ID, "autoAdvanceDelay").get_attribute("disabled") is not None
    b.d.find_element(By.CSS_SELECTOR, 'input[value="auto-submit"]').click()
    b.d.find_element(By.ID, "autoAdvance").click()
    delay = b.d.find_element(By.ID, "autoAdvanceDelay")
    delay.clear()
    delay.send_keys("2.5", Keys.TAB)
    b.d.find_element(By.ID, "pttKey").click()
    ActionChains(b.d).send_keys(Keys.ENTER).perform()  # reserved: refused
    ActionChains(b.d).send_keys("j").perform()
    b.wait(lambda: b.d.find_element(By.ID, "pttKey").text == "KeyJ", what="key captured")
    stored = b.d.execute_script("return window.__store")
    assert stored == {"submitMode": "auto-submit", "autoAdvance": True,
                      "autoAdvanceDelayMs": 2500, "pttKey": "KeyJ"}, stored


def test_shift_chords_and_taps_ignored(b):
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    field = b.d.find_element(By.ID, "user-response")
    field.click()
    # Shift+letters = typing a capital, not talking.
    ActionChains(b.d).key_down(Keys.SHIFT).pause(0.3).send_keys("ab").pause(0.3).key_up(Keys.SHIFT).perform()
    time.sleep(0.3)
    assert b.state() == "ready", b.state()
    assert b.input_value() == "AB", b.input_value()
    # A quick tap is not speech either.
    b.d.execute_script("arguments[0].value = ''", field)
    ActionChains(b.d).key_down(Keys.SHIFT).key_up(Keys.SHIFT).perform()
    time.sleep(0.3)
    assert b.state() == "ready" and b.input_value() == "", (b.state(), b.input_value())
    # A real hold still works.
    b.say("fire")
    b.wait_state("filled")
    assert b.input_value() == "fire"


def test_reload_replaces_orphaned_badge(b):
    b.set_options()
    b.open_review()
    # Simulate a badge left behind by a previous, unloaded instance.
    b.d.execute_script("document.documentElement.append(document.createElement('wkv-indicator'))")
    b.d.find_element(By.ID, "user-response")  # page still fine
    b.open_review()
    assert len(b.d.find_elements(By.CSS_SELECTOR, "wkv-indicator")) == 1


def test_custom_ptt_key(b):
    b.set_options(pttKey="KeyJ", submitMode="auto-submit")
    b.open_review()
    b.say("fire", key="j")
    b.wait(lambda: b.mock_log(), what="submission with custom key")
    assert b.mock_log()[-1]["answer"] == "fire"


TESTS = [test_unit, test_inactive_off_review_page, test_defaults_fill_only_push_to_talk,
         test_wrong_answer_not_corrected, test_auto_submit_and_advance,
         test_kanji_rejected_for_reading, test_hands_free, test_pause_toggle,
         test_options_page_saves,
         test_shift_chords_and_taps_ignored, test_custom_ptt_key,
         test_reload_replaces_orphaned_badge]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    failed = 0
    problems = policy.check()
    for p in problems:
        print("POLICY:", p)
    print(f"{'FAIL' if problems else 'ok  '} policy")
    failed += bool(problems)

    server, base = start_server()
    ext = build_test_extension()
    b = Browser(base, ext, headed=args.headed)
    try:
        for t in TESTS:
            if args.k not in t.__name__:
                continue
            try:
                note = t(b)
                print(f"ok   {t.__name__}" + (f" ({note})" if note else ""))
            except Exception as e:  # report and keep going
                failed += 1
                print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    finally:
        b.quit()
        server.shutdown()
        shutil.rmtree(ext, ignore_errors=True)
    print("all passed" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
