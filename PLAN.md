# WaniKani Voice — Plan

A Firefox extension that lets you answer WaniKani reviews by voice. Speech
recognition runs entirely on-device.

Status (2026-10-04): **Phase 2 done, pending a live check on WaniKani.**
English answers are recognised on-device (Whisper base.en in a worker) from
push-to-talk or hands-free speech, end to end in Firefox against the mock
review page. Japanese readings fall back to typing until Phase 3.

---

## 1. Requirements

### Privacy (hard constraints)
| # | Requirement | How the design meets it |
|---|---|---|
| P1 | Firefox extension | Manifest V3 WebExtension, Firefox-specific (`browser_specific_settings.gecko`) |
| P2 | Model runs locally; nothing leaves the device | Model weights ship inside the XPI. Inference runs in WASM/WebGPU inside the extension. Host access is `www.wanikani.com` only. The extension CSP is `connect-src 'self'`. Settings use `storage.local`, not `storage.sync`, which would go through Firefox Sync. The manifest declares `data_collection_permissions: none`. `test/policy.py` fails the build on any network API or foreign URL |

### Functional
| # | Requirement |
|---|---|
| F1 | Turn on automatically on the WaniKani reviews page |
| F2 | Recognise speech for: radical name (EN), kanji meaning (EN) / reading (JA), vocab meaning (EN) / reading (JA) |
| F3 | Japanese output is **hiragana only**, with no kanji |
| F4 | The page's question is **never** read or used as context. Only the question type is read: meaning/reading and radical/kanji/vocabulary |
| F5 | No correction toward the right answer. A wrong answer said aloud goes in as-is |
| F6 | Fill the answer box, and submit if the user chose that |
| F7 | When the next question appears, be ready to listen again |
| F8 | A page-injected indicator (top-right) shows listening / processing state |

### Decisions (from you, 2026-10-04)
| Topic | Decision | Implemented as |
|---|---|---|
| Submit | Option; **default: fill in only, you press Enter** | `submitMode`: `fill-only` (default) / `auto-submit` |
| Advance | Option; **default: you advance** | `autoAdvance` (default off) + `autoAdvanceDelayMs` (default 1.5 s) |
| Listening | Option; **default: push-to-talk on Shift** | `inputMode`: `push-to-talk` (default) / `voice-activity`. `pttKey` default `Shift` (either side), changeable |
| Scope | Reviews only for now | Activates only on `/subjects/review` |
| Distribution | Possibly public. Don't block AMO | See §6 |
| Numbers | Below 10 as words, above 10 as numerals | 0–10 → words, 11+ → numerals; 10 → "ten" (confirmed) |

All options are in the extension's settings page, which is also the toolbar
button's popup.

---

## 2. Key technical decisions

### 2.1 Speech recognition: two models, chosen by question type

The question type is the one piece of page context allowed (F4), and it
selects the model.

| Mode | Model (initial pick) | Why |
|---|---|---|
| **English** (meaning, radical name) | **Whisper `base.en`, 8-bit (77 MB)** via transformers.js 4.3 + onnxruntime-web (WASM) — **chosen in S5** | Best accuracy on real recordings; bigger variants were no better (S5) |
| **Japanese reading** | A **hiragana-output CTC model** (wav2vec2-XLSR fine-tuned to emit hiragana, e.g. `vumichien/wav2vec2-large-xlsr-japanese-hiragana`) exported to ONNX | Emits kana directly. No kanji to convert, no language model "fixing" what you said |

**Why not Whisper for Japanese:** it writes kanji (人), and converting back is
ambiguous (じん / にん / ひと). That ambiguity is exactly the reading being
tested, and Whisper also pulls toward real words, which breaks F5.
**Fallback:** Whisper with a fixed hiragana prompt and kanji tokens suppressed.
If kanji still comes out, we reject it and re-listen. We never guess.

**Rejected:** Web Speech API (server-based, and off in Firefox). Firefox's
`browser.trial.ml` (experimental, Mozilla-controlled model list, may download
at runtime). Vosk (its Japanese model emits kanji).

**Prior art, for contrast:** [kikoe](https://github.com/mattpatterson94/kikoe)
and [wanikani-voice-input](https://github.com/okonomichiyaki/wanikani-voice-input)
use the browser's cloud speech API and match against the item's known answers.
That's the opposite of P2/F4/F5, but their WaniKani selectors were a useful
cross-check.

### 2.2 Where things run

```
wanikani.com tab                                 extension background
┌────────────────────────────────────┐        ┌──────────────────────────────┐
│ content script                     │        │ background page              │
│  • page-reader (question TYPE only)│        │  • transcribe(mode, speech)  │
│  • mic capture + VAD   (Phase 2)   │─mode,─▶│  • normalisation             │
│  • answer-io (fill / submit)       │ speech │  └─ Worker: transformers.js  │
│  • indicator (closed shadow DOM)   │◀─text──│      EN / JA model (Phase 2) │
│  • main.js state machine           │        │                              │
└────────────────────────────────────┘        └──────────────────────────────┘
```

- **Built:** the request is `{type:'wkv:transcribe', mode, audio}`: 16 kHz
  mono PCM and a mode, nothing from the page (`fakeUtterance` replaces
  `audio` in test mode).
- **Mic capture** (`src/content/audio.js`) runs in the content script, so the
  permission belongs to `wanikani.com`. It asks for **raw** audio (no
  browser noise suppression, auto-gain or echo cancellation). It captures at
  the device rate through a ScriptProcessorNode, because Firefox can't connect
  a MediaStream to an AudioContext at a different rate, and an AudioWorklet
  would need a URL the page CSP allows. It then box-filter resamples to
  16 kHz. The mic opens on first use and stays open while enabled, with a
  300 ms pre-roll so the first syllable isn't lost. It's released when
  paused, when the tab is hidden, or on leaving the page.
- **Speech detection** is energy-based with an adaptive noise floor. It ends
  hands-free utterances after 800 ms of quiet. A clip with no detected speech
  is never sent to Whisper, because Whisper "hears" something like "you" in
  silence.
- **Inference** runs in a module Worker owned by the background page
  (`src/worker/`, bundled by esbuild into `build/dist/asr-worker.js`).
  Remote models are off, and onnxruntime's WASM runtime is the bundled copy
  in `vendor/ort/`, not the CDN transformers.js defaults to. Single-threaded,
  because extension pages aren't cross-origin isolated. Model load takes
  about 0.6 s, and decoding a short answer about 0.3 s (Node; similar in
  Firefox).
- **Fixed decoder prompt** (`src/worker/recognize.js`): a constant list of
  dictionary-style words that don't appear in the evaluation set. It's the
  same for every question, so F4 holds. It moved real-recording accuracy
  from 21/25 to 22/25 (raw) and from 18/25 to 20/25 (gated).

### 2.3 Enforcing "don't read the question" (F4) — built

- `src/content/page-reader.js` is the only module that reads WaniKani's
  question area. It returns `{subject, kind, mode}` from the category/type
  labels (`.quiz-input__question-category`, `.quiz-input__question-type`, with
  `data-question-type` as fallback).
- `src/content/answer-io.js` writes the answer box and presses submit. It
  reads only whether the answer has been graded.
- WaniKani's `didAnswerQuestion` / `willShowNextQuestion` events are used as
  timing signals. Their payloads contain the subject and are never read.
- `test/policy.py` fails if any other content module queries the DOM, if any
  content code mentions question/item selectors (`character-header`, item
  info, synonyms, `wkof`, embedded JSON) or `.detail`, or if any source has
  network APIs or non-WaniKani URLs. A deliberate violation was confirmed to
  fail it.

### 2.4 Normalisation (no correction) — built, `src/shared/normalize.js`

- **English:** NFKC, lower-case, strip punctuation (keep `'` inside words),
  split hyphenated words, collapse spaces. Then numbers: runs of number
  words/digits become one number (`twenty-one` → `21`, `one hundred and five`
  → `105`, `1,000` → `1000`), rendered as words for 0–10 and numerals above.
  Malformed runs like "one two" are left alone. Japanese text in English mode
  is rejected.
- **Japanese:** NFKC (fixes half-width kana), katakana → hiragana, strip spaces
  and punctuation, then require pure hiragana (plus ー). Kanji or romaji is
  **rejected** with a message. It is never converted.

### 2.5 Filling and submitting — built, unverified on live site

- Fill: the native `value` setter plus `input`/`change` events, so WaniKani's
  controllers and WanaKana see a normal edit. Kana passes WanaKana unchanged.
- Submit/advance: **click `.quiz-input__submit-button`**. That's the action
  Enter triggers, and it doesn't depend on WaniKani accepting synthetic key
  events. Synthetic Enter keys are only a fallback if the button is missing.
- "Graded" = the input container carries `correct="true|false"`. Events are
  not used as state (see S1 findings).

### 2.6 Question lifecycle — built, `src/content/main.js`

States: `off` · `unsupported` · `ready` · `listening` · `processing` ·
`filled` · `error` · `waiting`.

```
 new question ──▶ READY ──PTT down──▶ LISTENING ──PTT up──▶ PROCESSING
   ▲   (hands-free: straight to LISTENING; end of speech = PTT up)  │
   │                                                                ├─ rejected ─▶ ERROR ─2 s─▶ READY
   │                                                                ▼
   │                                            FILLED ──(auto-submit, or you press Enter)──▶ graded
   │                                            (PTT again = retry)                              │
   └──────── next question ◀── WAITING ◀────────────────────────────────────────────────────────┘
                               (auto-advance: clicks next after the delay)
```

The state is re-derived from the page on every relevant DOM mutation and quiz
event (debounced), so missing one signal doesn't wedge it. A new question
means graded→ungraded, or a change of question type. Transcripts that come
back after the question changed are dropped (generation counter). The PTT key
defaults to **Shift**, which types nothing by itself, so it is not swallowed.
Shift pressed together with another key (typing a capital, a shortcut)
cancels the recording, and presses shorter than 200 ms are ignored as taps.
A non-modifier PTT key, if you choose one, is swallowed while enabled so it
isn't typed into the box or seen as a WaniKani hotkey. Leaving the tab or window
while holding PTT cancels the recording. The content script matches all of
`www.wanikani.com` and activates on `/subjects/review`, re-checking on
`turbo:load`, because WaniKani uses Turbo navigation.

### 2.7 Indicator — built, `src/content/indicator.js`

A 40 px mic badge at **top: 72 px, right: 16 px** (to be checked against the
real header), in a closed shadow root. Red pulsing = listening, spinner =
processing, amber = error, crossed-out = paused/unsupported. Beside it: an
`EN` / `かな` mode tag and a status bubble (hint, transcript, or error).
Click to pause/resume. **Alt+Shift+V** toggles too (manifest `commands`).
While the recognizer is `fake`, a test-utterance field sits under the badge.
State is mirrored to `data-state` / `data-mode` on the host element for tests.

---

## 3. Project layout (as built)

```
manifest.json                  MV3, Firefox ≥140
src/background/background.js   speech worker lifecycle, transcribe, model status, commands
src/worker/asr-worker.js       transformers.js worker (bundled into build/dist/)
src/worker/recognize.js        Whisper decoding with the fixed prompt (shared with eval)
src/content/audio.js           mic capture, resampling, speech detection
src/content/page-reader.js     ONLY reader of the page: question type
src/content/answer-io.js       fill / submit / graded?
src/content/indicator.js       badge + test-utterance field
src/content/main.js            state machine
src/shared/normalize.js        EN/JA normalisation
src/shared/settings.js         defaults, storage.local
src/options/                   settings page = toolbar popup
icons/icon.svg
test/policy.py                 static privacy / F4 checks
test/unit/                     normalisation cases (run in Firefox)
test/mock/review.html          mock review page
test/hooks/settings-bridge.js  test-build-only settings access
test/options/index.html        options page harness (in-memory storage)
test/run_tests.py              runs everything (Selenium + geckodriver, headless Firefox)
tools/inspect-wanikani.js      console recorder for the live page structure (S1)
tools/build.mjs                assembles build/ (the loadable extension)
tools/fetch-models.mjs         downloads pinned, hash-checked models (models/models.json)
tools/eval-asr.mjs             offline accuracy on recordings (S5)
tools/recorder/                local page for recording evaluation clips
tools/make-test-audio.py       synthetic TTS fixtures (Piper)
models/                        bundled model (Git LFS) + models.json manifest
test/fixtures/audio/           WAV fixtures (Git LFS): en/ synthetic, real/ gated, real-raw/ raw
test/worker/index.html         runs the built worker in a plain page (debugging)
```

Sources are plain JavaScript. Only the worker is bundled (esbuild), because it
imports transformers.js. I didn't move to TypeScript or Vitest after all: the
code stays small, and tests run in real Firefox. Node 26 / npm 12 and git-lfs
were installed on 2026-10-04. Model files and WAVs are in Git LFS
(`.gitattributes`).


Tests: `npm run build && python3 test/run_tests.py`. Current result: policy
ok, 39 unit cases, 16 end-to-end scenarios. They include real speech through
the extension (push-to-talk, hands-free with autoplay unblock, numbers,
silence rejected) and the S2 idle-survival check. All non-localhost traffic
goes to a dead proxy, so any network dependency would fail them. The rest
cover: defaults (fill-only + PTT, no auto-advance), wrong
answer passed through uncorrected, auto-submit + auto-advance through
EN/JA/number questions, kanji rejected for readings, hands-free, pause
toggle, options page, Shift chords/taps ignored, custom PTT key, inactive
off the review page.

---

## 4. Phases

| Phase | Status |
|---|---|
| 0 — Spikes S1–S5 | S1 done except the live smoke test. **S2 and S5 done** (findings below). S3 needs the live test. S4 is Phase 3 |
| **1 — Skeleton with fake ASR** | **Done 2026-10-04** |
| **2 — Audio + English** | **Done 2026-10-04**, pending a live check on WaniKani |
| 3 — Japanese | |
| 4 — UX and robustness | Partly pulled into Phase 1 (options, hotkeys, pause, tab-hidden handling) |
| 5 — Privacy audit + packaging | |

### Spikes
| Spike | Question | Exit criterion |
|---|---|---|
| **S1** | Do the live page's selectors, graded attribute, events and header layout match the mock? | Capture from `tools/inspect-wanikani.js` (or a Marionette session), mock updated to match, live smoke test of Phase 1 |
| **S2** | Keeping a ~100–300 MB ONNX model warm in Firefox (MV3 event page vs MV2 persistent vs extension iframe). WebGPU on Firefox 157/Linux? | Model loads once per session; latency measured |
| **S3** | Does submit-button click + value set work on the live page with WanaKana? | Covered by S1's live smoke test |
| **S4** | JA accuracy: hiragana CTC vs constrained Whisper on ~50 self-recorded readings | ≥95 % exact kana on clear speech |
| **S5** | EN accuracy/latency: Whisper base.en / small.en / Moonshine on ~50 meanings | <1 s from end of speech to fill |

### S1 findings (live page, 2026-10-04, via Marionette, read-only)
- Markup: `div.quiz-input` → `label.quiz-input__question-type-container[data-question-type]`
  holding `span.quiz-input__question-category` ("Vocabulary") and
  `span.quiz-input__question-type` ("reading"). Then
  `div.quiz-input__input-container` → `form` → `input#user-response.quiz-input__input`
  + `button.quiz-input__submit-button[data-action="quiz-input#submitAnswer"]`.
  `div.quiz-input__exception-container[hidden]` holds wrong-type warnings.
- WanaKana is bound to the input on reading questions (`data-wanakana-bound`,
  `lang="ja"`) and unbound on meaning questions.
- Grading sets `correct="true|false"` on the input container and
  `enabled="false"` (an attribute, not `disabled`) on the input. Both reset
  when the next question loads.
- `didAnswerQuestion` fires **twice per question**: on grading, and again on
  advancing, immediately before `willShowNextQuestion`. Any state based on
  events would be fragile, so events only trigger a re-check of the DOM.
- The header statistics occupy the top-right ~35 px. The badge at 72 px
  clears them.
- Still open: a live smoke test with the extension loaded (fill-only
  default, so nothing is submitted without you), and seeing a wrong-type
  warning.

### S2 findings: keeping the model loaded (2026-10-04)
- **Firefox unloads an idle MV3 background page even while a content-script
  port is open**, and the loaded model goes with it. Seen with
  `extensions.background.idle.timeout` lowered for testing; the default is
  30 s.
- Fix: the review tab sends a heartbeat over its port every 5 s, and each
  message resets the idle timer. `test_background_survives_idle` checks that
  the same background instance and a ready model survive 20 s idle with an
  8 s timeout.
- No WebGPU in Firefox 157 on this Linux machine (`navigator.gpu` absent), so
  inference is WASM, which is fast enough for base.en.
- Firefox won't import an ES module through a symlink inside an extension
  (fetches through one work). The test build therefore copies scripts and
  symlinks only the models.
- Autoplay: without a click or key press on the page, an AudioContext stays
  suspended and `resume()` never settles. Hands-free mode therefore shows
  "Click the page or press Shift to start listening" and resumes on the next
  gesture. Push-to-talk is unaffected, since the key press is the gesture.

### S5 findings: English model choice (2026-10-04)
Recorded with `tools/recorder` (25 WaniKani-style meanings plus two noise
checks), scored by `tools/eval-asr.mjs` with the extension's own speech gate,
decoding and normalisation:

| Model (8-bit) | Size | Gated mic | **Raw mic** | Decode (Node) |
|---|---|---|---|---|
| **whisper-base.en** + fixed prompt | 77 MB | 20/25 | **22/25**, 2/2 noise | ~300 ms |
| whisper-base.en, no prompt | 77 MB | 18/25 | 21/25 | ~290 ms |
| whisper-small.en | 249 MB | 17/25 | 21/25 | ~560 ms |
| distil-small.en | 172 MB | 17/25 | 21/25 | ~490 ms |
| moonshine-base | 63 MB | 8/25 | 10/25 | ~60 ms |

- **The microphone path mattered more than model size.** The test
  machine runs a system-wide noise filter (a suppressor plus a noise gate)
  that captures every app's microphone stream. The gate chops soft word onsets (hand→"and",
  four→"or", to eat→"eat"). Raw audio fixed most of those. The "gated" set
  went through that filter; the "raw" set bypassed it.
- Remaining misses on raw audio: eye→"I", hand→"and", ground→"crown". sun→"son"
  was fixed by the prompt. Homophones can't be resolved without using the
  question, which F4 forbids.
- Synthetic Piper TTS clips (`test/fixtures/audio/en`) are unusable for
  accuracy, because Piper renders isolated words as clipped ~0.2 s blips. They
  remain useful as pipeline fixtures.

### Phase 2 — Audio + English (built)
`src/content/audio.js` (mic, resampling, speech detection),
`src/worker/` (transformers.js worker, shared decoding),
`src/background/background.js` (worker lifecycle, model status pushed to
review tabs, heartbeat, diagnostics), `tools/build.mjs` → `build/`.
Indicator shows model loading progress; Japanese questions show a "type this
one" state. Test mode (typed text) remains as an option.

### Phase 3 — Japanese
JA model chosen by S4. The normalisation and kanji rejection are already in
place.

### Phase 4 — UX and robustness
First-run model download/progress UI if not bundled. A "didn't catch that"
retry budget. Possibly "auto-advance only when correct". Indicator position
option if the default clashes with the header.

### Phase 5 — Privacy audit and packaging
Network Monitor + `about:networking` audit over a full session. `web-ext lint`.
Sign as unlisted on AMO, or list publicly (§6).

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Misheard answer counts against you | Default is fill-only: you see it before pressing Enter |
| Short Japanese readings (き, か) | S4. Longer endpoint pause for short utterances |
| WaniKani DOM changes | Selectors live in two files. If the type can't be read, the badge shows "unsupported" and does nothing |
| Model size vs 200 MB XPI limit | Quantised ONNX (int8/q4) |
| Background unloaded mid-session | Heartbeat (S2); verified by test |
| System noise filters (e.g. EasyEffects) degrade recognition | Extension asks for raw audio, but a system-wide filter can still capture the stream. Options: bypass it for Firefox, or soften it (open question) |
| Your voice recordings in the repo | `test/fixtures/audio/real*` are your voice. Fine in a private repo; review before making it public |
| Shift-as-PTT clashes with typing capitals | Chords cancel, taps under 200 ms are ignored. Key is configurable |

---

## 6. Keeping public publishing open

- Name "Voice Answers for WaniKani", not "WaniKani Voice". Using "for X" is the
  usual way to reference someone else's trademark in a listing. Unaffiliated;
  no WaniKani logo.
- `data_collection_permissions: ["none"]` is now required for new AMO
  listings, and it's true here.
- Minimal permissions: `storage` + `www.wanikani.com`. No `tabs`, no
  `<all_urls>`.
- AMO needs the source plus build instructions for review, because the
  worker is bundled: `npm ci && npm run build` (esbuild, not minified). `web-ext
  lint` on `build/`: 0 errors. Warnings are only `Function`/dynamic `import`
  inside transformers.js and onnxruntime (unused paths; the CSP forbids eval)
  and an Android min-version notice.
- XPI size today is ~103 MB (model 77 MB + WASM runtime 27 MB). A Japanese
  model must fit in the remaining ~95 MB under AMO's 200 MB limit, or be
  downloaded on first use (inbound only, but that's a P2 design decision for
  you).
- Model licences must allow redistribution (Whisper: MIT. Check the JA
  model's licence in S4).
- The add-on ID `wanikani-voice@jsmrcina` is permanent once published. Change
  it now if you'd prefer something else.

---

## 7. Open questions

1. **Noise filter:** bypass the system noise filter for Firefox, soften it,
   or leave it (about 20/25 instead of 22/25)?
2. **Live check:** load `build/` in your Firefox and try a few reviews
   (S1 smoke test plus S3).
3. **Phase 3 Japanese:** your 25 raw readings are recorded and ready for S4.
