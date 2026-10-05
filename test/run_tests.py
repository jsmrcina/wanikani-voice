"""Runs all tests: static policy checks, unit tests and end-to-end tests in a
real (headless) Firefox with the built extension (build/, from `npm run build`)
installed against test/mock.

Needs: Python with `selenium`, and `geckodriver` on PATH or in $GECKODRIVER.
    python3 test/run_tests.py [-k name-substring] [--headed]

All traffic except localhost goes to a dead proxy, so anything that tried to
reach the network (a CDN, a model host) would fail the tests.
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

BUILD = ROOT / "build"


def build_test_extension() -> Path:
    """Copy of build/ that also runs on http://localhost, with the indicator's
    shadow root open so the test can type into its test field. The models are
    symlinked to save copying ~80 MB; scripts can't be (Firefox refuses to
    import an ES module through a symlink in an extension)."""
    if not (BUILD / "manifest.json").exists():
        raise SystemExit("build/ is missing: run `npm run build` first")
    out = Path(tempfile.mkdtemp(prefix="wkv-ext-"))
    for item in BUILD.iterdir():
        if item.name == "models":
            (out / item.name).symlink_to(item)
        elif item.is_dir():
            shutil.copytree(item, out / item.name)
        else:
            shutil.copy(item, out / item.name)
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
        if os.environ.get("WKV_THEME"):  # screenshots: force light or dark
            opts.set_preference("layout.css.prefers-color-scheme.content-override",
                                0 if os.environ["WKV_THEME"] == "dark" else 1)
        # Nothing but localhost is reachable: a dead proxy for everything else.
        for scheme in ("http", "ssl"):
            opts.set_preference(f"network.proxy.{scheme}", "127.0.0.1")
            opts.set_preference(f"network.proxy.{scheme}_port", 9)
        opts.set_preference("network.proxy.type", 1)
        opts.set_preference("network.proxy.no_proxies_on", "localhost, 127.0.0.1")
        opts.set_preference("network.proxy.allow_hijacking_localhost", False)
        # Spike S2: unload idle extension background pages after 8 s (default
        # 30 s), to check that an open review session keeps ours alive.
        opts.set_preference("extensions.background.idle.timeout", 8000)
        service = Service(executable_path=os.environ.get("GECKODRIVER") or shutil.which("geckodriver"))
        self.d = webdriver.Firefox(options=opts, service=service)
        # Install by path (no zip upload): the build is ~100 MB.
        self.d.execute("INSTALL_ADDON", {"path": str(ext_dir), "temporary": True})

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

    def bridge(self, type_, **payload):
        """Round trip to test/hooks/settings-bridge.js in the current page."""
        return self.d.execute_async_script("""
            const [type, payload, done] = arguments;
            const id = Math.random();
            window.addEventListener('message', function on(e) {
              if (e.data?.type === type + '-result' && e.data.id === id) {
                window.removeEventListener('message', on); done(e.data.result);
              }
            });
            window.postMessage({ type, id, ...payload }, '*');""", type_, payload)

    def settings(self, replace=None):
        """Reads (and optionally replaces) the extension's stored settings."""
        if not self.d.current_url.startswith(self.base):
            self.d.get(self.base + "/elsewhere")
        return self.bridge("wkv-test:settings", replace=replace)

    def set_options(self, **settings):
        """Replaces all settings. Tests use the typed test mode unless they ask
        for the real recognizer."""
        self.d.get(self.base + "/elsewhere")
        self.settings(replace={"recognizer": "fake", **settings})

    def diag(self):
        return self.bridge("wkv-test:diag")

    def play(self, clip):
        """Plays a WAV from the private voice fixtures (personal/fixtures) into the
        fake mic; returns seconds."""
        return self.bridge("wkv-test:say", url=f"{self.base}/personal/fixtures/{clip}")

    def speak(self, clip, key=Keys.SHIFT):
        """Push-to-talk with real audio: hold the key while the clip plays."""
        self.d.find_element(By.ID, "user-response").click()
        ActionChains(self.d).key_down(key).perform()
        seconds = self.play(clip)
        time.sleep(seconds + 0.2)
        ActionChains(self.d).key_up(key).perform()

    def message(self):
        return self.host().get_attribute("data-message")

    def wait_model_ready(self, timeout=60):
        self.wait(lambda: self.state() == "ready" and self.message().startswith("Hold"), timeout,
                  "speech model loaded")

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
    total = 0
    for el in ("results", "ctc-results"):
        res = json.loads(b.wait(lambda: (t := b.d.find_element(By.ID, el).text) != "running" and t,
                                what=f"{el}"))
        assert not res["failures"], json.dumps(res["failures"], ensure_ascii=False, indent=1)
        total += res["total"]
    return f"{total} cases"


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


SPEECH_PREFIX = "real-raw/en/"
# Real-voice recordings live in the private submodule (personal/); tests that
# need them are skipped when it isn't checked out.
VOICE_FIXTURES = ROOT / "personal/fixtures/real-raw"


def needs_voice(test):
    test.needs_voice = True
    return test



@needs_voice
def test_speech_push_to_talk(b):
    b.set_options(recognizer="local")
    b.open_review()
    b.wait_model_ready()
    # The first press opens the microphone; with the fake mic there's no
    # permission prompt, so it records straight away.
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait_state("filled", timeout=20)
    assert b.input_value() == "fire", b.input_value()
    assert b.mock_log() == [], "fill-only must not submit"


@needs_voice
def test_speech_numbers_and_phrases(b):
    b.set_options(recognizer="local", submitMode="auto-submit", autoAdvance=True, autoAdvanceDelayMs=200)
    b.open_review()
    b.wait_model_ready()
    b.speak(SPEECH_PREFIX + "twenty-one.wav")  # radical question; wrong but must pass through as said
    b.wait(lambda: b.mock_log(), timeout=20, what="first answer")
    assert b.mock_log()[-1]["answer"] == "21", b.mock_log()
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", timeout=5, what="reading question")


def test_reading_choices(b):
    """The choices UI, driven deterministically by test mode ("a|b|c")."""
    b.set_options()
    b.open_review()
    b.say("fire")
    b.wait_state("filled")
    b.press_enter()
    b.wait_state("waiting")
    b.press_enter()  # kanji reading question (人)
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", 10, "reading question")
    b.say("ジン|ニン|ヒト")
    b.wait_state("filled")
    assert b.input_value() == "じん", b.input_value()
    assert b.host().get_attribute("data-choices") == "じん|にん|ひと"
    field = b.d.find_element(By.ID, "user-response")
    ActionChains(b.d).send_keys("3").perform()  # digits pick, never reach the box
    b.wait(lambda: b.input_value() == "ひと", 3, "third choice")
    assert b.host().get_attribute("data-selected") == "2"
    ActionChains(b.d).send_keys("1").perform()
    b.wait(lambda: b.input_value() == "じん", 3, "first choice again")
    # Once the user types their own answer, digits are left alone.
    b.d.execute_script("arguments[0].value = 'じ'", field)
    ActionChains(b.d).send_keys("2").perform()
    assert b.input_value() == "じ2", b.input_value()
    b.d.execute_script("arguments[0].value = 'にん'", field)
    b.press_enter()
    b.wait(lambda: len(b.mock_log()) == 2, 5, "reading submitted")
    assert b.mock_log()[-1]["answer"] == "にん", b.mock_log()
    b.wait(lambda: b.state() == "waiting" and not b.host().get_attribute("data-choices"), 3,
           "choices cleared after grading")


def test_answer_choices_english(b):
    """English answers get the same numbered choices (test mode "a|b|c")."""
    b.set_options()
    b.open_review()
    b.say("And|Hand")
    b.wait_state("filled")
    assert b.input_value() == "and"
    assert b.host().get_attribute("data-choices") == "and|hand"
    assert "another answer" in b.message(), b.message()
    ActionChains(b.d).send_keys("2").perform()
    b.wait(lambda: b.input_value() == "hand", 3, "second answer")
    b.press_enter()
    b.wait(lambda: b.mock_log(), 5, "submitted")
    assert b.mock_log()[-1]["answer"] == "hand", b.mock_log()


@needs_voice
def test_speech_japanese(b):
    """Real Japanese speech through the hiragana model: some valid kana reading
    is filled in (which one depends on the model, so it isn't asserted)."""
    b.set_options(recognizer="local", submitMode="auto-submit", autoAdvance=True, autoAdvanceDelayMs=200)
    b.open_review()
    b.wait_model_ready()
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", 20, "reading question")
    b.speak("real-raw/ja/yama.wav")
    b.wait(lambda: len(b.mock_log()) == 2, 20, "reading submitted")
    answer = b.mock_log()[-1]["answer"]
    assert answer and all("\u3041" <= c <= "\u3096" for c in answer), answer


@needs_voice
def test_speech_fast_english(b):
    """The 'fast' English setting uses whisper-tiny.en."""
    b.set_options(recognizer="local", englishSpeed="fast")
    b.open_review()
    b.wait_model_ready()
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait_state("filled", timeout=20)
    assert b.input_value() == "fire", b.input_value()
    models = b.diag()["models"]
    assert models.get("whisper-tiny.en", {}).get("status") == "ready", models


@needs_voice
def test_speech_silence_not_sent(b):
    b.set_options(recognizer="local")
    b.open_review()
    b.wait_model_ready()
    b.speak("real-raw/noise/silence.wav")
    b.wait_state("error", timeout=10)
    assert "hear" in b.message(), b.message()
    assert b.input_value() == ""


@needs_voice
def test_speech_hands_free(b):
    b.set_options(recognizer="local", inputMode="voice-activity", submitMode="auto-submit")
    b.open_review()
    # No interaction yet: Firefox keeps audio suspended, and the badge asks for a click.
    b.wait(lambda: b.state() == "error" and "Click the page" in b.message(), 20, "asks for a click")
    b.d.find_element(By.TAG_NAME, "body").click()
    b.wait(lambda: b.state() == "listening" and b.message() == "Listening…", 60, "mic open")
    b.play(SPEECH_PREFIX + "water.wav")  # no key: the speech detector ends it
    b.wait(lambda: b.mock_log(), timeout=30, what="hands-free answer")
    assert b.mock_log()[-1]["answer"] == "water", b.mock_log()


@needs_voice
def test_background_survives_idle(b):
    """Spike S2: with the idle timeout at 8 s, the background (and the loaded
    model) must outlive a longer pause while a review tab is open."""
    b.set_options(recognizer="local")
    b.open_review()
    b.wait_model_ready()
    before = b.diag()
    time.sleep(20)
    after = b.diag()
    assert before["startedAt"] == after["startedAt"], (before, after)
    assert after["workerAlive"] and after["models"]["whisper-base.en"]["status"] == "ready", after
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait_state("filled", timeout=20)


def test_auto_advance_only_correct(b):
    b.set_options(submitMode="auto-submit", autoAdvance=True, autoAdvanceDelayMs=200,
                  autoAdvanceOnlyCorrect=True)
    b.open_review()
    b.say("water")  # wrong (the radical is fire): stays put
    b.wait(lambda: b.mock_log(), 5, "graded")
    time.sleep(1.0)
    assert b.state() == "waiting" and b.mode() == "en", (b.state(), b.mode())
    assert "Not quite" in b.message(), b.message()
    b.press_enter()  # the user moves on
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", 5, "next question")
    b.say("じん")  # right: advances by itself
    b.wait(lambda: b.mode() == "en" and len(b.mock_log()) == 2, 5, "auto-advanced after a correct answer")


def test_hands_free_gives_up_after_misses(b):
    b.set_options(inputMode="voice-activity")
    b.open_review()
    for attempt in range(3):
        b.wait_state("listening", timeout=6)
        b.say_hands_free("")  # nothing recognisable
        if attempt < 2:
            b.wait_state("error")
    b.wait(lambda: b.state() == "ready" and "Stopped listening" in b.message(), 6, "gave up")
    time.sleep(3.5)
    assert b.state() == "ready", "no automatic retry after giving up"
    b.d.find_element(By.TAG_NAME, "body").click()
    b.wait_state("listening", timeout=3)


def test_panel_position(b):
    b.set_options(indicatorPosition="bottom-left")
    b.open_review()
    rect = b.d.execute_script(
        "return arguments[0].getBoundingClientRect().toJSON()",
        b.host().shadow_root.find_element(By.CSS_SELECTOR, ".wrap"))
    height = b.d.execute_script("return window.innerHeight")
    assert rect["left"] <= 20 and height - rect["bottom"] <= 20, (rect, height)


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
         test_reload_replaces_orphaned_badge, test_auto_advance_only_correct,
         test_hands_free_gives_up_after_misses, test_panel_position, test_speech_push_to_talk,
         test_speech_numbers_and_phrases, test_reading_choices, test_answer_choices_english,
         test_speech_japanese,
         test_speech_fast_english, test_speech_silence_not_sent,
         test_speech_hands_free, test_background_survives_idle]


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
            if getattr(t, "needs_voice", False) and not VOICE_FIXTURES.exists():
                print(f"skip {t.__name__} (private voice fixtures not checked out)")
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
