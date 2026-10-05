# Voice Answers for WaniKani

A Firefox extension for answering WaniKani reviews by voice. Speech recognition
runs on your device, inside Firefox: Whisper base.en for English, and a small
hiragana model for readings. Nothing you say leaves your computer. See
[PLAN.md](PLAN.md) for the design, findings and roadmap.

**Status: Phase 3.** Meanings, radical names and readings all work by voice.
The panel also offers up to two other answers it heard (e.g. *hand* for
*and*, にん for じん): press **1–3** to switch before you submit.

## Build and try it

```bash
git lfs pull            # model files and audio fixtures live in Git LFS
npm ci
npm run build           # -> build/ (the loadable extension, ~150 MB)
```

1. In Firefox, open `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** → pick `build/manifest.json`.
2. Open https://www.wanikani.com/subjects/review. A mic badge appears at the
   top right and loads the speech model (about a second).
3. Hold **Shift**, say the answer, release. The first press asks for
   microphone permission. The answer is filled in; press Enter to submit
   (default).

Settings live in the toolbar button's popup (also under about:addons):
- push-to-talk or hands-free
- fill-only or auto-submit
- auto-advance and its delay
- the push-to-talk key
- test mode, where typed text stands in for speech (`a|b|c` simulates
  alternatives)

Click the badge or press **Alt+Shift+V** to pause.

**System audio processing hurts recognition.** Noise gates and suppressors,
such as an EasyEffects input chain, cut off the start of words. The extension
asks Firefox for raw audio, but EasyEffects captures every app's microphone
stream unless Firefox is on its input blocklist. See PLAN.md (S5).

### Private data (`personal/` submodule)

`personal/` is the private repository
[wanikani-voice-private](https://github.com/jsmrcina/wanikani-voice-private): voice
recordings, the WaniKani word list and the fine-tuned model. Nothing in it is
needed to build or test the add-on. Without access to it, leave the submodule
uninitialised; tests that need real recordings are then skipped. With access:

```bash
git submodule update --init personal
(cd personal && git lfs install --local && git lfs pull)
```

## Packaging for addons.mozilla.org

```bash
npm run package              # add -- --verify to rebuild from the source zip and compare
```

This does a clean normal build (never a personal one), then runs the privacy
policy check, `web-ext lint` (errors fail it) and the 200 MB size check. It
writes `dist/voice-answers-for-wanikani-<version>.xpi`, the source archive AMO
asks for when a package contains bundled code (`…-source.zip`, with a
`SOURCE-README.md` of build steps), and `SHA256SUMS`. The working tree must
be committed.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install selenium
# geckodriver: https://github.com/mozilla/geckodriver/releases (on PATH or $GECKODRIVER)
npm run build && .venv/bin/python test/run_tests.py   # --headed to watch, -k name to filter
```

This runs:
- **`test/policy.py`:** static checks that:
  - only `page-reader.js` and `answer-io.js` touch the page
  - nothing references the question/item markup or event payloads
  - there's no network code
  - the manifest's host access is WaniKani only
- **Unit tests** for answer normalisation (`test/unit/`).
- **End-to-end tests** in headless Firefox against a mock review page
  (`test/mock/review.html`), including real speech:
  - WAV clips are played into a fake microphone and recognised by the bundled
    model.
  - Every non-localhost request goes to a dead proxy, so any network
    dependency fails the run.
  - They use a test copy of `build/` that also matches `http://localhost` and
    adds a bridge for settings, the fake mic and diagnostics
    (`test/hooks/`).

## Speech model work

```bash
node tools/fetch-models.mjs [name]                   # pinned, sha256-checked downloads (models/models.json)
node tools/eval-asr.mjs [model ...] --set real-raw [--ja]   # accuracy on recordings, same pipeline as the extension
python3 tools/recorder/server.py --set NAME          # record evaluation clips at http://localhost:8765/
```

### Fine-tuning the reading model on your voice (personal build)

```bash
mkdir -p ~/.config/wanikani-voice   # put a read-only WaniKani API token in api-token
python3 tools/wk-readings.py                     # -> personal/words.json (your readings)
python3 tools/recorder/server.py --words personal/words.json --set personal
python tools/finetune-hiragana.py                # needs torch + transformers
python tools/export-dual-ctc.py personal/models/distilhubert-hiragana/checkpoint - personal/models/distilhubert-hiragana
npm run build -- --personal                      # build/ with your model; never publish it
```

`personal/` is the private submodule (above), so none of this is in the public repository.

Only models marked `"bundled": true` in `models/models.json` are committed
and shipped. The others are evaluation candidates. The hiragana model is
exported locally (`"generatedBy"` gives the exact command; needs PyTorch).
`fetch-models` verifies its committed files instead of downloading them.

Third-party models and libraries and their licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Layout

```
manifest.json
src/background/background.js   speech worker lifecycle, transcribe + choices, model status, commands
src/worker/                    transformers.js worker, Whisper and hiragana CTC decoding (bundled)
src/content/page-reader.js     the ONLY reader of the page: question type
src/content/answer-io.js       fill the answer box / press submit
src/content/audio.js           microphone capture, resampling, speech detection
src/content/indicator.js       top-right badge (closed shadow root)
src/content/main.js            state machine
src/shared/normalize.js        EN/JA answer normalisation
src/shared/settings.js         defaults + storage.local
src/options/                   settings page / toolbar popup
models/                        bundled model (Git LFS) + manifest
tools/                         build, model fetch/eval, recorder, page inspector
test/                          policy, unit, end-to-end tests and fixtures
```
