# Voice Answers for WaniKani

A Firefox extension for answering WaniKani reviews by voice. Speech recognition
runs on your device, and nothing you say leaves it. See [PLAN.md](PLAN.md) for
the design and roadmap.

**Status: Phase 1 (skeleton).** There's no speech model yet. A test field under
the indicator stands in for your voice: type what you would have said.

## Try it

1. In Firefox, open `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → pick `manifest.json` in this folder.
2. Open https://www.wanikani.com/subjects/review. A mic badge appears at the
   top right.
3. Type a test utterance (e.g. `Fire.` or `ジン`) into the field under the
   badge, click back into the answer box, then press and release **`**. This
   is the push-to-talk key, standing in for speaking.
4. The answer is normalised (`fire`, `じん`) and filled in. Press Enter to
   submit (default). Pressing Enter in the test field also "speaks" it.

Settings live in the toolbar button's popup (also under about:addons):
push-to-talk or hands-free, fill-only or auto-submit, auto-advance and its
delay, and the push-to-talk key. Click the badge or press **Alt+Shift+V** to
pause.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install selenium
# geckodriver: https://github.com/mozilla/geckodriver/releases (on PATH or $GECKODRIVER)
.venv/bin/python test/run_tests.py          # add --headed to watch, -k name to filter
```

This runs:
- `test/policy.py`: static checks that only `page-reader.js` and `answer-io.js`
  touch the page, nothing references the question/item markup or event
  payloads, there's no network code, and the manifest's host access is
  WaniKani only.
- Unit tests for answer normalisation (`test/unit/`).
- End-to-end tests in headless Firefox against a mock review page
  (`test/mock/review.html`), using a test build that also matches
  `http://localhost` and adds a settings bridge (`test/hooks/`).

## Layout

```
manifest.json
src/background/background.js   recognition (fake for now), commands
src/content/page-reader.js     the ONLY reader of the page: question type
src/content/answer-io.js       fill the answer box / press submit
src/content/indicator.js       top-right badge (closed shadow root)
src/content/main.js            state machine
src/shared/normalize.js        EN/JA answer normalisation
src/shared/settings.js         defaults + storage.local
src/options/                   settings page / toolbar popup
tools/inspect-wanikani.js      console snippet to record the live page structure
```
