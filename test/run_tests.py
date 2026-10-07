"""Runs all tests: static policy checks, unit tests and end-to-end tests in a
real (headless) Firefox with the built extension (build/, from `npm run build`)
installed against test/mock; or, with --browser chrome, in headless Chromium
with build-chrome/ (`node tools/build.mjs --target chrome`).

Needs: Python with `selenium`, and `geckodriver` (Firefox) or `chromium` +
`chromedriver` (Chrome) on PATH, or $GECKODRIVER / $CHROMEDRIVER.
    python3 test/run_tests.py [--browser firefox|chrome] [-k name-substring] [--headed]

All traffic except localhost goes to a dead proxy, so anything that tried to
reach the network (a CDN, a model host) would fail the tests.
"""
import argparse
import subprocess
import http.server
import socketserver
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
from selenium.webdriver.common.actions import interaction
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.firefox.service import Service

sys.path.insert(0, str(Path(__file__).parent))
import policy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ADDON_ID = "wanikani-voice@jsmrcina"
ADDON_UUID = "6f1e0c52-3a8b-4c7e-9d41-2b5a7e9c0d11"


# ---- local server ------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    ROUTES = {"/subjects/review": "test/mock/review.html", "/elsewhere": "test/unit/index.html",
              # The lesson quiz uses the same quiz UI; lesson content pages don't.
              "/subject-lessons/440-441/quiz": "test/mock/review.html",
              "/subjects/lesson/quiz": "test/mock/review.html",
              "/subject-lessons/440-441": "test/unit/index.html"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def translate_path(self, path):
        clean = path.split("?")[0].rstrip("/")
        if clean in self.ROUTES:
            return str(ROOT / self.ROUTES[clean])
        return super().translate_path(path)

    def log_message(self, *a):
        pass


class RefusingProxy(socketserver.ThreadingTCPServer):
    """HTTP(S) proxy that refuses every request and records what was asked
    for: the privacy audit. Firefox sends all non-localhost traffic here."""
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self):
        self.requests = []
        outer = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                line = self.rfile.readline(4096).decode("latin-1").strip()
                if line:
                    method, _, rest = line.partition(" ")
                    outer.requests.append(f"{method} {rest.rsplit(' ', 1)[0]}")
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")

        super().__init__(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]


def start_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://localhost:{server.server_address[1]}"


# ---- extension test build -----------------------------------------------------

BUILD = ROOT / "build"


def build_test_extension(target="firefox") -> Path:
    """Copy of build/ (build-chrome/ for Chrome) that also runs on
    http://localhost, with the indicator's shadow root open so the test can
    type into its test field. The models are symlinked to save copying
    ~80 MB; scripts can't be (Firefox refuses to import an ES module through a
    symlink in an extension)."""
    BUILD = ROOT / ("build-chrome" if target == "chrome" else "build")
    if not (BUILD / "manifest.json").exists():
        raise SystemExit(f"{BUILD.name}/ is missing: run `node tools/build.mjs --target {target}` first")
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
    # The custom-model hook fetches test model files from the local server.
    csp = manifest["content_security_policy"]
    csp["extension_pages"] = csp["extension_pages"].replace("connect-src 'self'", "connect-src 'self' http://localhost:*")
    # Custom-model install hook, using the real model store.
    shutil.copy(ROOT / "test/hooks/bg-hook.js", out / "bg-hook.js")
    if target == "chrome":  # a service worker: add the hooks to its imports
        sw = out / "src/background/service-worker.js"
        sw.write_text(sw.read_text() + "importScripts('../shared/zip-reader.js', '../shared/model-store.js', '../../bg-hook.js');\n")
    else:
        manifest["background"]["scripts"] += ["src/shared/zip-reader.js", "src/shared/model-store.js", "bg-hook.js"]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    ind = out / "src/content/indicator.js"
    ind.write_text(ind.read_text().replace("mode: 'closed'", "mode: 'open'"))
    return out


# ---- browser helpers ----------------------------------------------------------

class Browser:
    def __init__(self, base, ext_dir, headed=False, proxy_port=9, touch=False, target="firefox"):
        self.base = base
        self.target = target
        if target == "chrome":
            self._start_chrome(ext_dir, headed, proxy_port, touch)
            return
        opts = webdriver.FirefoxOptions()
        if not headed:
            opts.add_argument("-headless")
        if touch:
            # A phone, as far as CSS and matchMedia can tell: coarse pointer,
            # no hover (LookAndFeel bits: 1 coarse, 2 fine, 4 hover).
            opts.set_preference("ui.primaryPointerCapabilities", 1)
            opts.set_preference("ui.allPointerCapabilities", 1)
        opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: ADDON_UUID}))
        if os.environ.get("WKV_THEME"):  # screenshots: force light or dark
            opts.set_preference("layout.css.prefers-color-scheme.content-override",
                                0 if os.environ["WKV_THEME"] == "dark" else 1)
        # Nothing but localhost is reachable: everything else goes to a proxy
        # that refuses it and records the attempt (the privacy audit).
        for scheme in ("http", "ssl"):
            opts.set_preference(f"network.proxy.{scheme}", "127.0.0.1")
            opts.set_preference(f"network.proxy.{scheme}_port", proxy_port)
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
        if touch:
            self.d.set_window_size(412, 915)  # Pixel 9 Pro XL, CSS pixels

    def _start_chrome(self, ext_dir, headed, proxy_port, touch):
        opts = webdriver.ChromeOptions()
        opts.binary_location = os.environ.get("CHROMIUM") or shutil.which("chromium")
        if not headed:
            opts.add_argument("--headless=new")
        opts.add_argument(f"--load-extension={ext_dir}")
        opts.add_argument(f"--disable-extensions-except={ext_dir}")
        # Privacy audit: everything but localhost goes to the refusing proxy,
        # and Chrome's own background traffic is switched off, so any request
        # that still arrives came from the page or the extension.
        opts.add_argument(f"--proxy-server=http://127.0.0.1:{proxy_port}")
        opts.add_argument("--proxy-bypass-list=<-loopback>;localhost;127.0.0.1")
        for flag in ("--disable-background-networking", "--disable-component-update", "--no-pings",
                     "--disable-sync", "--no-first-run", "--no-default-browser-check",
                     "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication"):
            opts.add_argument(flag)
        opts.add_argument("--window-size=412,915" if touch else "--window-size=1280,900")
        service = ChromeService(executable_path=os.environ.get("CHROMEDRIVER") or shutil.which("chromedriver"))
        self.d = webdriver.Chrome(options=opts, service=service)
        if touch:
            # A phone, as far as CSS and matchMedia can tell: touch emulation
            # makes the primary pointer coarse with no hover.
            self.d.execute_cdp_cmd("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
            self.d.execute_cdp_cmd("Emulation.setEmulatedMedia", {"features": [
                {"name": "pointer", "value": "coarse"}, {"name": "hover", "value": "none"},
                {"name": "any-pointer", "value": "coarse"}, {"name": "any-hover", "value": "none"}]})

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

    def open_review_off(self):
        self.d.get(self.base + "/subjects/review/")
        self.wait(lambda: self.state() == "off", what="indicator off")

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

    def panel(self, selector):
        return self.host().shadow_root.find_element(By.CSS_SELECTOR, selector)

    def touch(self, el, hold=0.05, slide_to=None):
        """A finger on el: press, hold, optionally slide to another element, lift."""
        finger = PointerInput(interaction.POINTER_TOUCH, "finger")
        ab = ActionBuilder(self.d, mouse=finger)
        ab.pointer_action.move_to(el).pointer_down().pause(hold)
        if slide_to is not None:
            ab.pointer_action.move_to(slide_to)
        ab.pointer_action.pointer_up()
        ab.perform()

    def press_enter(self):
        ActionChains(self.d).send_keys(Keys.ENTER).perform()


# ---- tests --------------------------------------------------------------------

def test_unit(b):
    b.d.get(b.base + "/test/unit/index.html")
    total = 0
    for el in ("results", "ctc-results", "repeat-results"):
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


def test_lesson_quiz(b):
    """Lesson quizzes (both URL forms) get the panel; lesson content doesn't."""
    b.set_options()
    for path in ("/subject-lessons/440-441/quiz/", "/subjects/lesson/quiz/"):
        b.d.get(b.base + path)
        b.wait(lambda: b.state() == "ready", 5, f"panel on {path}")
        b.say("fire")
        b.wait_state("filled")
        assert b.input_value() == "fire"
    b.d.get(b.base + "/subject-lessons/440-441/")
    time.sleep(0.5)
    assert b.state() is None, "no panel on lesson content pages"


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
    """Off in the settings: PTT does nothing; pressing the panel's mic turns it back on."""
    b.set_options(enabled=False)
    b.open_review_off()
    b.say("fire")
    time.sleep(0.3)
    assert b.state() == "off" and b.input_value() == "", "paused: PTT does nothing"
    assert b.message().startswith("Voice answers are off"), b.message()
    b.panel(".badge").click()
    b.wait_state("ready")
    stored = b.settings()
    assert stored.get("enabled") is True, stored


def test_mic_button_mouse(b):
    """The panel's mic button is hold-to-talk with a mouse too; Send and Submit work."""
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    ActionChains(b.d).click_and_hold(b.panel(".badge")).pause(0.3).release().perform()
    b.wait_state("filled")
    assert b.input_value() == "fire", b.input_value()
    assert b.host().get_attribute("data-actions") == "submit", "no Clear with a keyboard"
    assert b.message() == "fire — Enter to submit, or Shift to retry", b.message()
    b.panel(".submit").click()
    b.wait(lambda: b.mock_log(), what="submission via the panel")
    b.wait_state("waiting")
    assert b.host().get_attribute("data-actions") == "next"
    b.panel(".next").click()
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", what="reading question")
    assert not b.host().get_attribute("data-actions")
    b.set_utterance("じん")
    b.panel(".send").click()
    b.wait_state("filled")
    assert b.input_value() == "じん", b.input_value()


def test_auto_submit_has_no_submit_button(b):
    b.set_options(submitMode="auto-submit")
    b.open_review()
    b.say("fire")
    b.wait_state("waiting")
    assert b.host().get_attribute("data-actions") == "next"


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


def firefox_only(test):
    test.firefox_only = True
    return test


def chrome_only(test):
    test.chrome_only = True
    return test



@needs_voice
def test_speech_push_to_talk(b):
    b.set_options(recognizer="local", englishSpeed="accurate")
    b.open_review()
    b.wait_model_ready()
    # The first press opens the microphone; with the fake mic there's no
    # permission prompt, so it records straight away.
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait_state("filled", timeout=20)
    assert b.input_value() == "fire", b.input_value()
    assert b.mock_log() == [], "fill-only must not submit"
    assert b.diag()["models"].get("whisper-base.en", {}).get("status") == "ready"


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
    """The 'fast' English setting (the default) uses Moonshine; a repeated word is collapsed."""
    b.set_options(recognizer="local", englishSpeed="fast")
    b.open_review()
    b.wait_model_ready()
    for clip, want in (("fire.wav", "fire"), ("king.wav", "king")):
        b.d.execute_script("document.getElementById('user-response').value = ''")
        b.speak(SPEECH_PREFIX + clip)
        try:
            b.wait_state("filled", timeout=20)
        except AssertionError:
            raise AssertionError(f"{clip}: {b.state()} {b.message()!r}")
        assert b.input_value() == want, (clip, b.input_value())
    models = b.diag()["models"]
    assert models.get("moonshine-base", {}).get("status") == "ready", models
    return f"last decode {b.diag()['lastDecodeMs']} ms"


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


@chrome_only
@needs_voice
def test_service_worker_restart(b):
    """Spike C2: Chrome stops idle extension service workers. The speech
    worker lives in the offscreen document, so after a restart the models are
    still loaded (ready again within moments, not a full reload) and the next
    answer works."""
    b.set_options(recognizer="local")
    b.open_review()
    b.wait_model_ready(timeout=120)
    before = b.diag()
    b.d.execute_cdp_cmd("ServiceWorker.enable", {})
    b.d.execute_cdp_cmd("ServiceWorker.stopAllWorkers", {})
    t0 = time.time()
    b.wait(lambda: b.diag()["startedAt"] != before["startedAt"], 10, "service worker restarted")
    b.wait(lambda: all(m.get("status") == "ready" for m in b.diag()["models"].values()), 10, "models ready again")
    ready_in = time.time() - t0
    b.wait_model_ready(timeout=10)
    b.speak(SPEECH_PREFIX + "fire.wav")
    b.wait_state("filled", timeout=20)
    assert b.input_value() == "fire", b.input_value()
    return f"models ready {ready_in:.1f} s after the restart"


@firefox_only
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
    assert after["workerAlive"] and after["models"]["moonshine-base"]["status"] == "ready", after
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


TEST_MODELS = ROOT / "dist/test-models"


def pack_test_models():
    """Model files for the custom-model tests: tiny.en packed for English, the
    hiragana model mislabelled... and a Whisper model with broken weights."""
    TEST_MODELS.mkdir(parents=True, exist_ok=True)
    pack = lambda d, lang, out, name: subprocess.run(
        ["node", "tools/pack-model.mjs", str(d), "--language", lang, "--name", name, "--out", str(TEST_MODELS / out)],
        cwd=ROOT, check=True, capture_output=True)
    pack(ROOT / "models/whisper-tiny.en", "en", "tiny.wkv-model.zip", "test tiny.en")
    pack(ROOT / "models/moonshine-base", "en", "moonshine.wkv-model.zip", "test moonshine")
    pack(ROOT / "models/distilhubert-hiragana", "ja-kana", "hiragana.wkv-model.zip", "test hiragana")
    broken = Path(tempfile.mkdtemp(prefix="wkv-broken-"))
    shutil.copytree(ROOT / "models/whisper-tiny.en", broken, dirs_exist_ok=True)
    for f in (broken / "onnx").glob("*.onnx"):
        f.write_bytes(b"not an onnx model")
    pack(broken, "en", "broken.wkv-model.zip", "broken")
    shutil.rmtree(broken)


def custom(b, slot, zip_name=None):
    """Installs (or with zip_name=None removes) a custom model via the test hook."""
    if not b.d.current_url.startswith(b.base):
        b.d.get(b.base + "/elsewhere")
    if zip_name is None:
        return b.bridge("wkv-test:remove-custom", slot=slot)
    b.d.set_script_timeout(120)
    return b.bridge("wkv-test:install-custom", slot=slot, name=zip_name,
                    url=f"{b.base}/dist/test-models/{zip_name}")


def test_custom_model_english(b):
    b.set_options(recognizer="local")
    res = custom(b, "en", "tiny.wkv-model.zip")
    assert res["ok"], res
    model_id = res["meta"]["id"]
    b.open_review()
    b.wait_model_ready(timeout=90)
    models = b.diag()["models"]
    assert models.get(model_id, {}).get("status") == "ready", models
    if VOICE_FIXTURES.exists():
        b.speak(SPEECH_PREFIX + "fire.wav")
        b.wait_state("filled", timeout=20)
        assert b.input_value() == "fire", b.input_value()
    assert custom(b, "en")["ok"]


def test_custom_model_moonshine(b):
    """A custom English model can be a Moonshine one (e.g. fine-tuned on your voice)."""
    b.set_options(recognizer="local", englishSpeed="accurate")  # so the custom model is what loads Moonshine
    res = custom(b, "en", "moonshine.wkv-model.zip")
    assert res["ok"], res
    assert res["meta"]["kind"] == "moonshine", res
    model_id = res["meta"]["id"]
    b.open_review()
    b.wait_model_ready(timeout=90)
    models = b.diag()["models"]
    assert models.get(model_id, {}).get("status") == "ready", models
    assert "whisper-base.en" not in models, models
    if VOICE_FIXTURES.exists():
        b.speak(SPEECH_PREFIX + "king.wav")
        b.wait_state("filled", timeout=20)
        assert b.input_value() == "king", b.input_value()
    assert custom(b, "en")["ok"]


def test_custom_model_wrong_language_rejected(b):
    b.set_options(recognizer="local")
    res = custom(b, "en", "hiragana.wkv-model.zip")
    assert not res["ok"] and "not English" in res["error"], res
    assert b.settings().get("customModels", {}) == {}, "nothing stored"


def test_custom_model_broken_falls_back(b):
    b.set_options(recognizer="local")
    res = custom(b, "en", "broken.wkv-model.zip")
    assert res["ok"], res
    b.open_review()
    b.wait(lambda: "failed to load" in (b.message() or "") and b.message().startswith("Hold"), 90,
           "fallback notice")
    assert b.diag()["models"].get("moonshine-base", {}).get("status") == "ready"
    assert custom(b, "en")["ok"]


def test_options_custom_models(b):
    """The settings page's Custom models rows (real model store, page origin)."""
    b.d.get(b.base + "/test/options/index.html")
    row = lambda slot: b.d.find_element(By.CSS_SELECTOR, f'.model-row[data-slot="{slot}"]')
    status = lambda slot: row(slot).find_element(By.CSS_SELECTOR, ".model-status").text
    b.wait(lambda: "built-in" in status("ja-kana"), 5, "rows rendered")

    def choose(slot, name):
        field = row(slot).find_element(By.CSS_SELECTOR, "input[type=file]")
        b.d.execute_script("arguments[0].hidden = false", field)
        field.send_keys(str(TEST_MODELS / name))

    choose("ja-kana", "tiny.wkv-model.zip")
    b.wait(lambda: "can't use" in status("ja-kana"), 20, "wrong language refused")
    assert "not readings" in status("ja-kana"), status("ja-kana")
    choose("ja-kana", "hiragana.wkv-model.zip")
    b.wait(lambda: status("ja-kana").startswith("custom: test hiragana"), 60, "installed")
    assert b.d.execute_script("return window.__store.customModels['ja-kana'].kind") == "ctc"
    row("ja-kana").find_element(By.CSS_SELECTOR, ".reset").click()
    b.wait(lambda: "built-in" in status("ja-kana"), 10, "reset")


def test_custom_ptt_key(b):
    b.set_options(pttKey="KeyJ", submitMode="auto-submit")
    b.open_review()
    b.say("fire", key="j")
    b.wait(lambda: b.mock_log(), what="submission with custom key")
    assert b.mock_log()[-1]["answer"] == "fire"


# ---- touch-only device (second browser: coarse pointer, no hover, phone size)

def test_touch_detected(b):
    assert b.d.execute_script("return matchMedia('(hover: none) and (pointer: coarse)').matches"), \
        "touch emulation prefs not honoured"


def test_touch_review_flow(b):
    """A whole review by touch: hold the mic, tap a choice, Submit, Next."""
    b.set_options()
    b.open_review()
    assert b.message() == "Test mode (no mic): type below, then tap Send", b.message()
    b.settings(replace={"recognizer": "local"})  # wording with a real recognizer...
    b.open_review()
    b.wait(lambda: b.message().startswith("Hold the mic to answer") or b.message().startswith("Loading"),
           what="touch wording")
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    b.touch(b.panel(".badge"), hold=0.3)
    b.wait_state("filled")
    assert b.input_value() == "fire", b.input_value()
    assert b.d.execute_script("return document.activeElement?.id") != "user-response", \
        "filling must not focus the answer box (on-screen keyboard)"
    assert b.message() == "fire — tap Submit, or hold the mic to retry", b.message()
    b.touch(b.panel(".submit"))
    b.wait(lambda: b.mock_log(), what="submission by touch")
    b.wait_state("waiting")
    assert b.message() == "Tap Next for the next question", b.message()
    b.touch(b.panel(".next"))
    b.wait(lambda: b.mode() == "ja-kana" and b.state() == "ready", what="reading question")
    time.sleep(0.2)  # the page focuses the answer box on a new question
    assert b.d.execute_script("return document.activeElement?.id") != "user-response", \
        "Next must not leave the on-screen keyboard up"
    b.set_utterance("ジン|ニン|ヒト")
    b.touch(b.panel(".badge"), hold=0.3)
    b.wait_state("filled")
    assert b.message().startswith("Tap another reading"), b.message()
    b.touch(b.host().shadow_root.find_elements(By.CSS_SELECTOR, ".choices button")[2])
    b.wait(lambda: b.input_value() == "ひと", 3, "third choice by touch")


def test_touch_slide_off_cancels(b):
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    b.touch(b.panel(".badge"), hold=0.3, slide_to=b.d.find_element(By.ID, "user-response"))
    time.sleep(0.3)
    assert b.state() == "ready" and b.input_value() == "", (b.state(), b.input_value())
    b.touch(b.panel(".badge"), hold=0.05)  # a tap is not speech
    time.sleep(0.3)
    assert b.state() == "ready" and b.input_value() == "", (b.state(), b.input_value())


def test_touch_clear(b):
    """Clear empties the answer box without the on-screen keyboard."""
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    b.touch(b.panel(".badge"), hold=0.3)
    b.wait_state("filled")
    assert b.host().get_attribute("data-actions") == "submit clear"
    b.touch(b.panel(".clear"))
    b.wait_state("ready")
    assert b.input_value() == ""
    assert b.d.execute_script("return document.activeElement?.id") != "user-response"


def test_touch_drift_still_records(b):
    """A thumb drifting just off the mic while talking doesn't cancel."""
    b.set_options()
    b.open_review()
    b.set_utterance("fire")
    badge = b.panel(".badge")
    finger = PointerInput(interaction.POINTER_TOUCH, "finger")
    ab = ActionBuilder(b.d, mouse=finger)
    ab.pointer_action.move_to(badge).pointer_down().pause(0.2).move_to(badge, 30, 0).pause(0.2).pointer_up()
    ab.perform()
    b.wait_state("filled")
    assert b.input_value() == "fire"


def test_touch_mic_stays_put(b):
    """With choices and Submit showing at the bottom, pressing the mic hides
    them; the mic must not move, and letting go where it was still records."""
    b.set_options(indicatorPosition="bottom-right")
    b.open_review()
    b.set_utterance("And|Hand")
    b.touch(b.panel(".badge"), hold=0.3)
    b.wait_state("filled")
    before = b.d.execute_script("return arguments[0].getBoundingClientRect().toJSON()", b.panel(".badge"))
    b.set_utterance("Fire|Fir")
    # Note where the mic is once listening starts, from inside the page: one
    # continuous press (chromedriver doesn't keep a finger down across actions).
    b.d.execute_script("""
        const host = document.querySelector('wkv-indicator');
        window.__during = null;
        new MutationObserver(() => {
          if (host.dataset.state === 'listening' && !window.__during) {
            window.__during = host.shadowRoot.querySelector('.badge').getBoundingClientRect().toJSON();
          }
        }).observe(host, { attributes: true });""")
    finger = PointerInput(interaction.POINTER_TOUCH, "finger")
    ab = ActionBuilder(b.d, mouse=finger)
    ab.pointer_action.move_to_location(int(before["x"] + before["width"] / 2), int(before["y"] + before["height"] / 2))
    ab.pointer_action.pointer_down().pause(0.3).pointer_up()
    ab.perform()
    during = b.d.execute_script("return window.__during")
    assert during and abs(during["y"] - before["y"]) < 2, (before, during)
    try:
        b.wait(lambda: b.input_value() == "fire", what="second recording kept")
    except AssertionError:
        raise AssertionError(f"{b.state()} {b.message()!r} value {b.input_value()!r} before {before} during {during}")


def test_touch_layout(b):
    """Phone-sized screens get a full-width bar with finger-sized buttons."""
    width = b.d.execute_script("return innerWidth")
    height = b.d.execute_script("return innerHeight")
    rect = lambda sel: b.d.execute_script("return arguments[0].getBoundingClientRect().toJSON()", b.panel(sel))
    b.set_options(indicatorPosition="bottom-right")
    b.open_review()
    wrap = rect(".wrap")
    assert wrap["left"] <= 10 and width - wrap["right"] <= 10, (wrap, width)
    assert height - wrap["bottom"] <= 12, (wrap, height)
    assert rect(".badge")["width"] >= 56
    b.set_options(indicatorPosition="top-left")
    b.open_review()
    assert rect(".wrap")["top"] <= 10


def test_touch_options_hide_ptt_key(b):
    b.d.get(b.base + "/test/options/index.html")
    b.wait(lambda: b.d.find_element(By.ID, "ptt-row"), what="options page")
    assert not b.d.find_element(By.ID, "ptt-row").is_displayed(), "no key to pick on a phone"


TOUCH_TESTS = [test_touch_detected, test_touch_review_flow, test_touch_slide_off_cancels,
               test_touch_clear, test_touch_drift_still_records, test_touch_mic_stays_put, test_touch_layout, test_touch_options_hide_ptt_key]

TESTS = [test_unit, test_inactive_off_review_page, test_lesson_quiz, test_defaults_fill_only_push_to_talk,
         test_wrong_answer_not_corrected, test_auto_submit_and_advance,
         test_kanji_rejected_for_reading, test_hands_free, test_pause_toggle,
         test_mic_button_mouse, test_auto_submit_has_no_submit_button,
         test_options_page_saves,
         test_shift_chords_and_taps_ignored, test_custom_ptt_key,
         test_reload_replaces_orphaned_badge, test_custom_model_english, test_custom_model_moonshine,
         test_custom_model_wrong_language_rejected, test_custom_model_broken_falls_back,
         test_options_custom_models,
         test_auto_advance_only_correct,
         test_hands_free_gives_up_after_misses, test_panel_position, test_speech_push_to_talk,
         test_speech_numbers_and_phrases, test_reading_choices, test_answer_choices_english,
         test_speech_japanese,
         test_speech_fast_english, test_speech_silence_not_sent,
         test_speech_hands_free, test_background_survives_idle, test_service_worker_restart]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--browser", choices=("firefox", "chrome"), default="firefox")
    args = ap.parse_args()

    failed = 0
    problems = policy.check()
    for p in problems:
        print("POLICY:", p)
    print(f"{'FAIL' if problems else 'ok  '} policy")
    failed += bool(problems)

    pack_test_models()
    server, base = start_server()
    proxy = RefusingProxy()
    ext = build_test_extension(args.browser)
    def run(tests, touch=False):
        nonlocal failed
        tests = [t for t in tests if args.k in t.__name__]
        if not tests:
            return
        b = Browser(base, ext, headed=args.headed, proxy_port=proxy.port, touch=touch, target=args.browser)
        try:
            for t in tests:
                if getattr(t, "firefox_only", False) and args.browser != "firefox":
                    print(f"skip {t.__name__} (Firefox only)")
                    continue
                if getattr(t, "chrome_only", False) and args.browser != "chrome":
                    print(f"skip {t.__name__} (Chrome only)")
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

    try:
        run(TESTS)
        run(TOUCH_TESTS, touch=True)
    finally:
        server.shutdown()
        shutil.rmtree(ext, ignore_errors=True)
    # Privacy audit: the browser's own background traffic goes to its
    # vendor (Firefox: Mozilla's Remote Settings and certificates; Chromium:
    # Google's update, time and account endpoints, despite the flags in
    # _start_chrome). Anything else would have come from the page or the
    # extension, and fails the run.
    import re as _re
    browser_name, vendor_name, pattern = (("Chromium", "Google", r"(^|\.)(google\.com|googleapis\.com|gvt1\.com)$")
                       if args.browser == "chrome" else
                       ("Firefox", "Mozilla", r"(^|\.)mozilla\.(com|net|org)$"))
    host = lambda r: _re.sub(r"^\S+ (https?://)?([^/:]+).*$", r"\2", r)
    foreign = [r for r in proxy.requests if not _re.search(pattern, host(r))]
    print(f"ok   privacy audit: {len(proxy.requests)} outside requests, all from {browser_name} to {vendor_name} hosts"
          if not foreign else f"FAIL privacy audit: {len(foreign)} requests to non-{vendor_name} hosts")
    for r in sorted(set(foreign)):
        print(f"   {foreign.count(r)}x {r}")
    failed += bool(foreign)
    print("all passed" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
