# WaniKani Voice — Plan

A Firefox extension that lets you answer WaniKani reviews by voice. Speech
recognition runs entirely on-device.

Status (2026-10-06): **v0.2.0 adds Firefox for Android** (touch controls,
tested on a Pixel 9 Pro XL) and makes Moonshine the default English model;
**v0.2.1** adds custom (fine-tuned) Moonshine models and better repeat
collapsing; both signed in the unlisted channel. **v0.1.2 is in review on
addons.mozilla.org (listed).** English meanings and radical names are
recognised by Moonshine (*fast*) or Whisper (*accurate*), readings by a small
hiragana CTC model, with up to three choices. Everything runs on-device.
Verified on the live site in reviews and lesson quizzes, on desktop and
phone. Next steps are in §8.

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
| **English** (meaning, radical name), *fast* — **the default since 2026-10-06** | **Moonshine base, 8-bit (64 MB)** via transformers.js 4.3 + onnxruntime-web (WASM) | Encodes only the clip, not Whisper's fixed 30 s window: ~0.1 s per answer on a desktop, ~0.3 s on a Pixel 9 Pro XL. 20–21/25 first choice on real recordings (Phase 6) |
| **English**, *accurate* | **Whisper `base.en`, 8-bit (77 MB)** — **chosen in S5** | Best accuracy on real recordings (22/25 first, 25/25 offered); bigger variants were no better (S5). ~1.5 s desktop, ~4 s phone |
| **Japanese reading** | **distilhubert-hiragana-ctc** (Apache-2.0), exported to ONNX by `tools/export-dual-ctc.py`, MatMul-only int8 (51 MB) — **chosen in S4** | Emits hiragana directly, so there's no kanji to convert and no language model inventing words. Best first-choice accuracy, tiny and fast (~20 ms). Up to 3 alternatives from beam search, which you pick between |

**Why not Whisper for Japanese:** it writes kanji (人), and converting back is
ambiguous (じん / にん / ひと). That ambiguity is exactly the reading being
tested. Even constrained to hiragana (`recognizeKana` in
`src/worker/recognize.js`, kept for evaluation), it invents phrases
(すみません, しなくて) and did worse (S4).

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
  and punctuation. **ー is spelled out**: o- and u-rows take う, the e-row
  takes い, and the a- and i-rows repeat the vowel (きょー→きょう,
  せんせー→せんせい). The hiragana model writes long vowels phonetically;
  this is a spelling convention and never looks at the question. Then the
  result must be pure hiragana and must not start with ん, っ or a small kana
  (that's a hum or cough). Kanji or romaji is **rejected** with a message,
  never converted.
- **Alternatives:** every candidate a recogniser returns is normalised; the
  valid, distinct ones are kept, best first, up to 3
  (`src/background/background.js`). English (added 2026-10-04) works like
  readings. Whisper's top first tokens within 5% of the best are each
  completed greedily, reusing one encoder pass (transformers.js 4.3 has no
  real beam search and drops a precomputed `encoder_outputs` unless it's
  added to `forward_params`).
  - On raw recordings, the right English answer is offered 25/25 (first
    choice 22/25): eye→`i / hi / eye`, hand→`and / hand`,
    ground→`crown / ground / crowd`.
  - Cost in Firefox: +0–300 ms on a ~1.6 s decode.

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

A bordered panel at **top: 72 px, right: 16 px**, which clears the live
header's statistics. It lives in a closed shadow root. One row holds the
add-on icon, the status message (hint, transcript or error), the `EN` /
`かな` mode tag and a round mic button. Reading choices and the test-mode
field appear below it when they apply.
- **The panel border shows state:** red when listening, blue when processing,
  green when filled, amber on an error. The mic button pulses while
  listening, spins while processing, and is crossed out when paused or
  unsupported.
- **Light and dark** follow `prefers-color-scheme`.
- **The icon** (`icons/icon.svg`, made by `tools/make-icon.py`: a microphone
  with an overlapping あ outlined from Noto Sans CJK JP Black) is inlined by
  `tools/build.mjs`, so the page never loads extension files.
- Click the mic to pause or resume. **Alt+Shift+V** toggles too (manifest
  `commands`).
- State is mirrored to `data-state`, `data-mode`, `data-choices` and
  `data-selected` on the host element, for tests.

---

## 3. Project layout (as built)

```
manifest.json                  MV3, Firefox ≥140
src/background/background.js   speech worker lifecycle, transcribe, model status, commands
src/worker/asr-worker.js       transformers.js worker (bundled into build/dist/)
src/worker/recognize.js        Whisper decoding (fixed prompt), hiragana CTC decoding (shared with eval)
src/worker/ctc.js              CTC prefix beam search (reading alternatives)
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
tools/make-icon.py             generates icons/icon.svg (mic + あ)
tools/export-dual-ctc.py       exports the hiragana model to ONNX (+ partial int8)
tools/export-ctc.py            generic CTC export (optimum), for other candidates
tools/eval-ja-torch.py         S4 comparison of hiragana models in PyTorch
models/                        bundled models (Git LFS) + models.json manifest
test/fixtures/audio/en/        synthetic (Piper) WAV fixtures (Git LFS)
personal/                      private submodule (wanikani-voice-private): voice recordings
                               (fixtures/real, fixtures/real-raw, recordings/), WaniKani word
                               list, fine-tuned models
test/worker/index.html         runs the built worker in a plain page (debugging)
```

Sources are plain JavaScript. Only the worker is bundled (esbuild), because it
imports transformers.js. I didn't move to TypeScript or Vitest after all: the
code stays small, and tests run in real Firefox. Node 26 / npm 12 and git-lfs
were installed on 2026-10-04. Model files and WAVs are in Git LFS
(`.gitattributes`).


Tests: `npm run build && python3 test/run_tests.py`. Current result: policy
ok, 53 unit cases (normalisation, CTC beam search), 19 end-to-end scenarios.
They include real English and Japanese speech through the extension
(push-to-talk, hands-free with autoplay unblock, numbers, silence rejected),
the reading-choices UI, and the S2 idle-survival check. All non-localhost traffic
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
| 0 — Spikes S1–S5 | **Done** (findings below); S1 and S3 confirmed by live use |
| **1 — Skeleton with fake ASR** | **Done 2026-10-04** |
| **2 — Audio + English** | **Done 2026-10-04**, verified live |
| **3 — Japanese** | **Done 2026-10-04**, verified live |
| **4 — UX and robustness** | **Done 2026-10-04**: Silero VAD, speed (English speed setting), retry limit, correct-only advance, panel position, fine-tuning on your voice (right reading offered 24/31 vs 13/31) |
| **5 — Privacy audit + packaging** | Done 2026-10-04, released as **v0.1.1** (signed by Mozilla, GitHub release): lessons and custom models verified live, automated privacy audit, packaging and signing, README, MIT licence, private data split out, repo recreated. Personal notes removed from the plan and from history (2026-10-05). Next steps in §8 |
| 6 — Firefox for Android | **Built 2026-10-06** (below): touch controls, phone layout, Android mic gain, Moonshine as the default English model. Tested on a Pixel 9 Pro XL. v0.2.0 signed (unlisted) |
| 7 — Chrome Web Store (desktop) | **Built 2026-10-07** (below): Chrome build target, offscreen speech worker, the whole suite on Chromium. Store submission waits for the developer account |

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
- Live use since then has confirmed filling, submitting, grading and the
  next-question handling on the real page, in reviews and lesson quizzes.

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

### S4 findings: Japanese model choice (2026-10-04)
Your 25 raw readings (JLPT N5/N4: single-mora answers, じん/にん/ひと, long
vowels, small っ, yōon, rendaku), scored like the extension. Exact match
after normalisation:

| Model | Shippable size | First choice | Notes |
|---|---|---|---|
| **distilhubert-hiragana CTC**, greedy + beam alternatives | **51 MB**, ~20 ms | **10/25**; right reading offered **11/25** | No invented words. Both noise checks rejected |
| wavlm-base-plus-hiragana-ctc-v2 (CC-BY-SA-3.0) | ~95 MB | 8/25 | Same family, worse here |
| wav2vec2-large-xlsr-japanese-hiragana | ~320 MB | 3/25 | Too big; adds trailing vowels |
| Whisper base, hiragana-only decoding | ~80 MB | 6/25 | Invents phrases |
| Whisper small, hiragana-only decoding | ~250 MB | 10/25 | Too big; invents phrases (すみません) |

- **The models agree on the same "errors"** (にん→ねん, て→た, くち→けち,
  りょこう→よこう, びょういん→よういん). Very different architectures hearing
  the same thing points at the speaker's pronunciation rather than
  model quality. The extension
  doesn't check readings against the answer (F4), so it types what it hears.
  Offering the alternatives the audio supports is the compromise you chose
  (option 1).
- **Quantisation:** plain dynamic int8 of the whole graph (24 MB) dropped
  10/25 to 6/25. Quantising only the transformer's MatMuls, per-channel signed
  int8 (51 MB), matches fp32 (99.9% frame agreement).
- **Greedy beats beam for the first choice.** Beam search's top hypothesis
  tends to append ー (か→かー); greedy doesn't. So greedy goes first and the
  beam supplies alternatives, minus those under 5% of the top hypothesis.
- **Trimming clips to speech hurt** (じん→ん): this model needs the
  surrounding context. Not done, for either language.
- **Speech detection moved to 20 ms frames.** Spoken answers (even か)
  give runs of 120–300 ms; the push-to-talk key's click and other bumps stay
  ≤ 80 ms. Threshold: 100 ms. Thin margin, so see Phase 4 (Silero VAD).

**Addendum (after live testing, 2026-10-04):** 了解 lost its ょ and 西欧 its
long vowels. Six more raw recordings (せいおう, りょうかい, ちょっと, きって,
しゅっぱつ, じょうず) showed:
- **Small っ and ょ themselves are fine:** ちょっと and きって come out exactly.
- **りょ → よ in every model** (distilhubert よかい, WavLM よーかい,
  wav2vec2-large るようをかい). The r is very soft in these recordings.
- **せいおう → せよ,** with せいよう (西洋) among the choices.
- Totals on 31 readings: distilhubert 12/31 first choice, right reading
  offered 13/31; WavLM 10/31, so a bigger model doesn't help.
- A blank penalty (to keep short sounds) hurt as the main decode and showed
  no gain as an extra alternative, so it was not kept.
- The fix that targets this is adapting the model to your voice: Phase 4,
  fine-tuning.

### Phase 3 — Japanese (built)
`models/distilhubert-hiragana/` (exported, Git LFS; the vocabulary is in
`config.json`), `src/worker/ctc.js` (prefix beam search), `recognizeCtc` in
`src/worker/recognize.js`. Background normalises and ranks up to three
choices. The badge shows them as numbered buttons; keys 1–3 (or a click) swap
the filled reading, but only while the box still holds an offered reading,
so typing a correction works normally. Choices clear on grading. Test mode
accepts `a|b|c` to simulate alternatives.

### Phase 4 — UX and robustness (done, 2026-10-04)
Your decisions: the tuned model ships in a **personal build** only; the training
list comes from **your WaniKani items**; VAD and speed are done while you
record.

- **Fine-tuning on your voice (pipeline; results below).**
  - `tools/wk-readings.py` reads a read-only API token from
    `~/.config/wanikani-voice/api-token` and lists the accepted readings of
    your unlocked kanji and vocabulary. Readings with the hard sounds (small
    ゃゅょ, っ, long vowels, the r-row) are always kept, up to 400. It writes
    `personal/words.json`. The extension itself never calls the API.
  - `tools/recorder/server.py --words personal/words.json --set personal`
    records into `personal/recordings/`. `personal/` is the private
    submodule `wanikani-voice-private`.
  - `tools/finetune-hiragana.py`:
    - trains the transformer and kana CTC head with CTC loss (frozen
      convolutional encoder, with speed/gain/noise/shift augmentation) on
      WaniKani spellings
    - keeps 10% for validation and never trains on the committed 31 raw
      readings, which are the before/after benchmark
    - saves the best checkpoint
    - CPU is enough: ~1 s per epoch per 26 clips, so ~8 min for 400 clips ×
      30 epochs
  - `tools/export-dual-ctc.py CHECKPOINT - personal/models/distilhubert-hiragana`
    exports it.
  - `npm run build -- --personal` swaps it into `build/` and stamps
    `BUILD-INFO.txt` "PERSONAL BUILD … Do not publish". A normal build puts
    the generic model back.
  - Smoke-tested end to end on the gated recordings (2 epochs, CPU).
- **Fine-tuning results (2026-10-04).** 400 recordings of your WaniKani
  readings (75% with hard sounds), 360 for training and 40 for validation,
  on CPU. Scored on the 31 benchmark readings through the extension's real
  pipeline (only 4 of them, て/しゅくだい/じゅう/じょうず, also appear in the
  training list):

  | Model | Validation (greedy) | Benchmark first choice | Benchmark offered | Train time |
  |---|---|---|---|---|
  | Generic | 14/40 | 13/31 | 13/31 | n/a |
  | **Full fine-tune** (20M weights) | **32/40** | **18/31** | **24/31** | 7 min |
  | Head-only (0.69M weights) | 29/40 | 16/31 | 20/31 | 3.5 min |

  - The full model gets りょうかい exactly, and offers がっこう, しゅくだい,
    しゅっぱつ and にん. Still missed: りょこう→よこう, びょういん→よういん.
  - Both tuned models turn the "um" noise clip into kana (あんうん)
    instead of rejecting it. Not pursued for now.
  - **Head-only**, which is what could train inside the extension in plain
    JS, gets a bit over half the full gain on the benchmark.
  - The full model is in your personal build (`npm run build -- --personal`),
    loaded in your Firefox 2026-10-04.
  - **Decision (2026-10-04): no in-extension training for now.** The
    personal build gives the better result. Revisit if the add-on is
    published (it would matter more to other users).
- **Silero VAD (done).** A 2.2 MB MIT ONNX model in the worker
  (`src/worker/vad.js`) decides whether a clip contains speech (≥ 96 ms at
  p > 0.5).
  - On the real recordings, the click-only clip peaks at p = 0.04; every
    answer has ≥ 160 ms at p ≈ 0.99.
  - The page now sends anything audible, and the energy detector only ends
    hands-free utterances.
  - `tools/eval-asr.mjs` gates clips the same way (onnxruntime-node).
- **Speed (done).**
  - Firefox ignores `cross_origin_embedder_policy` /
    `cross_origin_opener_policy` in the manifest: no cross-origin isolation,
    no `SharedArrayBuffer`, so no WASM threads.
  - onnxruntime's plain WASM build (14 MB) replaces the WebGPU-capable
    "asyncify" one (27 MB), via an esbuild alias. That's ~8% faster, and the
    linter's `eval` warnings are gone.
  - **English speed setting:** *accurate* (base.en, ~1.5–1.8 s, the default)
    or *fast* (tiny.en, 42 MB, ~0.8–1.0 s; right answer offered 23/25
    instead of 25/25, first choice 22/25 either way). Only the selected
    model loads; switching mid-review loads the new one.
  - Add-on size: 184 MB.
- **Hands-free retry limit (done).** After 3 failed attempts at one question,
  hands-free stops listening ("Stopped listening after 3 tries: click the
  page or hold Shift to try again"); a click or key press resumes.
- **Auto-advance only when correct (done).** An option under auto-advance: a
  wrong answer stays on screen ("Not quite…") until you press Enter. It
  reads WaniKani's `correct="true|false"`, i.e. the graded state, never the
  answer.
- **Panel position (done).** Top right (default), top left, bottom right or
  bottom left, in settings.

### Phase 5 — Privacy audit and packaging
Requested 2026-10-04, after Phase 4:
- **AMO packaging script (done, 2026-10-04):** `npm run package`
  (`tools/package.mjs`) does a clean normal build (it refuses a personal
  one), the policy check, `web-ext lint` (errors fail it) and the 200 MB
  check. It writes `dist/…-<version>.xpi`, `…-source.zip` (tracked sources
  and bundled models plus `SOURCE-README.md`, without tests or `personal/`)
  and `SHA256SUMS`. `--verify` rebuilds from the source zip and compares
  every file. First package: **v0.1.0**; the manifest version was reset
  from the internal 0.4.0 phase numbering.
- **README rewrite (done, 2026-10-04):** what the add-on does, install
  and use, the privacy guarantees and how each is enforced, and how it
  works:
  - a Mermaid data-flow flowchart and a sequence diagram of one answer
    (both checked with the Mermaid parser)
  - a components table
  - the recognition and normalisation rules
  - custom models and fine-tuning, development, testing, and packaging
    and signing
- **Going public (done).** History was rewritten on 2026-10-04
  (`git filter-repo`) to remove `test/fixtures/audio/real*` (your voice).
  The GitHub repository was recreated, so no orphaned LFS objects remain,
  and made public on 2026-10-05. `personal/` stays a private submodule.
- **Custom model files (done, verified live 2026-10-04).** You loaded your
  fine-tuned reading model (`My voice (full fine-tune).wkv-model.zip`, repacked
  as `My voice (readings)` on 2026-10-07 so it isn't mistaken for the English one) into
  the signed v0.1.1 through the settings, and it works. Settings → *Custom models*
  has *Choose file…* and *Reset to built-in* for English and for readings.
  - **Model file:** a `.wkv-model.zip` made by `tools/pack-model.mjs
    MODEL_DIR --language en|ja-kana`. It holds the model files
    transformers.js loads plus `wkv-model.json` (`format`, `language`,
    `kind`, `name`). ONNX files are stored uncompressed. Your fine-tuned
    readings model packs to 49 MB.
  - **Install:** the settings page unpacks it (`src/shared/zip-reader.js`:
    stored/deflate via `DecompressionStream`) and validates it
    (`src/shared/model-store.js`): language, kind, required files, and
    Whisper config or kana vocabulary. It's stored in the extension's
    IndexedDB, and a summary in `settings.customModels`, so the background
    sees the change.
  - **Load:** the worker reads the files from IndexedDB and serves them to
    transformers.js through its `env.customCache` hook. transformers.js
    checks the cache before loading any model file, so there's no network
    code and no `fetch` patching.
  - **Broken custom model:** its ONNX files are first opened with
    onnxruntime directly. transformers.js queues all session creation on
    one shared promise chain, and one failure there broke *every* later
    load, built-in models included (seen in testing). The background
    then switches that language back to the built-in model, and the panel
    says so.
  - **Tests:** a custom English model is used end to end, a model for the
    wrong language is refused, a broken model falls back, and the settings
    UI flow works.
  - Without the private submodule, the public build can now use a
    voice-tuned model. An English fine-tuning pipeline (Whisper) is still to
    do; any exported Whisper model can already be packed and used.
- **Lessons (done, verified live 2026-10-04).** The panel
  runs on lesson quizzes, `/subject-lessons/<ids>/quiz` and the older
  `/subjects/lesson/quiz`, as well as reviews. Lesson content pages without
  an answer box are left alone. Matched by `pageReader.isQuizPage`; covered
  by `test_lesson_quiz`. You confirmed it works on a real lesson quiz with the
  signed v0.1.1.
- **Privacy audit (automated, 2026-10-04).** Every test run sends all
  non-localhost traffic to a proxy that refuses it and records the
  destination. The run fails if anything goes to a host other than
  Mozilla's.
  - A full run records ~180 attempts, all Firefox's own background traffic
    to Mozilla's servers: Remote Settings, content-signature certificates,
    archive.mozilla.org.
  - None goes to model hosts, CDNs or WaniKani.
  - A planted `fetch('https://example.org/…')` fails the audit, as it
    should.
  - Combined with the static policy check (no network code or URLs in
    `src/`) and the CSP (`connect-src 'self'`).

Network Monitor + `about:networking` audit over a full session. `web-ext lint`.
Sign as unlisted on AMO, or list publicly (§6).

### Phase 6 — Firefox for Android (built 2026-10-06; release pending)

**Goal:** the same add-on (one package; AMO no longer accepts per-platform
files) works on Firefox for Android, with touch equivalents for every
keyboard interaction, on recognition speed a phone can handle.

**What Android supports** (MDN browser-compat-data 8.1.4, 2026-10-01):
| Used by the add-on | Firefox for Android |
|---|---|
| MV3, background scripts, content scripts, `host_permissions`, `action` popup, `options_ui`, CSP | Yes |
| `storage`, `runtime.connect`, `runtime.getPlatformInfo` | Yes |
| `getUserMedia`, `AudioContext`, `ScriptProcessorNode`, module workers, IndexedDB, `DecompressionStream('deflate-raw')` | Yes |
| WebAssembly with SIMD | Yes (ARM) |
| `commands` (keyboard shortcuts, Alt+Shift+V) | **No** |
| `data_collection_permissions` | From **142**: needs `browser_specific_settings.gecko_android.strict_min_version: "142.0"`. This is also the long-standing Android lint warning |
| WebGPU | **No**, so CPU/WASM only, as on Linux desktop |

So the technical core carries over unchanged. The work is input,
layout, speed and memory.

**Touch for every keyboard interaction** (inventory from the code):
| # | Keyboard today | Touch equivalent |
|---|---|---|
| K1 | Hold Shift (or the chosen key) to talk; Shift chords and taps under 200 ms ignored | **Press and hold the mic button**: pointer events, so it works for touch, mouse and pen. The button gets ≥ 56 px on touch screens and keeps the pointer captured while held. Letting go more than 72 px from where the press started cancels (see the findings below for why not "sliding off the button"). The same 200 ms minimum applies |
| K2 | 1–3 switch between choices | Tap the choice chips (already clickable); ≥ 44 px tall on touch screens |
| K3 | Enter to submit | A **Submit** button in the panel when an answer is filled in (calls the same `answerIO.submit`); auto-submit stays an option |
| K4 | Enter for the next question | A **Next** button in the panel while graded; auto-advance stays an option |
| K5 | Alt+Shift+V to pause; a click on the mic button also pauses | **No pause button** (tried, then removed at the user's request): pause with *Enabled* in the settings (or Alt+Shift+V on desktop). While paused, pressing the mic button turns voice answers back on |
| K6 | "Click the page or press a key" to start audio or resume hands-free | Already pointer events, so a tap works; only the wording changes |
| K7 | Enter in the test-mode field | A **Send** button next to the field |
| K8 | Settings: press a key to choose the push-to-talk key | Hidden on touch-only devices (no keyboard to hold), with a note that the mic button is used |

Plus:
- **No `focus()` on the answer box after filling on touch devices**, so the
  phone's keyboard doesn't pop up over the page.
- **A Clear button** (touch screens only) next to Submit, to empty the
  answer box without the on-screen keyboard.
- **Messages adapt to the input method** ("Hold the mic to answer",
  "Tap a reading", "Tap Submit"), chosen by `(hover: none) and
  (pointer: coarse)`. Devices with both (tablets with keyboards, touch
  laptops) keep every keyboard shortcut.

**Layout:** on narrow screens (< 600 px) the panel becomes a full-width bar,
at the **bottom by default** (the position setting can move it to the top),
so it doesn't cover the question, with the mic button where a thumb reaches
it. Anchored at the bottom, the rows that come and go (choices, buttons) sit
*above* the mic row, and the panel follows `visualViewport` so it stays
above the on-screen keyboard.

**Speed and memory: spike A1, measured on the Pixel 9 Pro XL (2026-10-06)**
over the debugging protocol (decode time in the worker, per answer):
| Model | Phone | Desktop (Ryzen 9 9950X3D) |
|---|---|---|
| Whisper base.en (*accurate*) | 3.9–5.0 s | ~1.5 s |
| Whisper tiny.en (old *fast*) | 1.9–2.3 s | ~0.8 s |
| **Moonshine base (new *fast*, default)** | **0.25–0.4 s** | ~0.1 s |
| distilhubert-hiragana (readings) | 0.35–0.6 s | ~0.4 s end to end |
- Whisper's cost is its encoder, which always processes a 30 s window; the
  decode is a few tokens. Dropping English alternatives would not have
  helped. Moonshine and the CTC model process only the clip.
- Memory on desktop (growth of the whole Firefox process tree with a review
  open and models loaded): +426 MB with *fast*, +723 MB with *accurate*.
- Android loads the reading model lazily, on the first reading question
  (a `prepare` message from the tab); it loaded in ~0.65 s on the phone.

**Moonshine (2026-10-06).** S5 had rejected `moonshine-base` at 10/25, but
that run fed it Whisper's decoder prompt and input format. With its own
start token and raw-audio input it scored 16/25. Two generic fixes, neither
using the question, brought it to 20–21/25 first choice (21–22 offered) on
clips padded like the mic path:
- `min_new_tokens: 1`: on short clips it often ended before its first word.
  Silero VAD has already found speech, so it must say something. This was
  also what made it fail in Firefox at first (the mic path adds 0.3 s of
  pre-roll).
- Collapse a phrase repeated back to back ("king king", "21 21").
- Remaining misses: moon→"no", eye→"I", ground→"crowned".
- `moonshine-tiny` was too weak (9–14/25). Padding clips to 2–3 s made both
  worse.
- **Decision (user, 2026-10-06):** Moonshine base replaces tiny.en as
  *fast* and becomes the default on desktop and Android; tiny.en is no
  longer bundled (kept in `models/` for the custom-model tests). Package
  ~148 MB zipped, 206 MB installed.

**Microphone on Android (2026-10-06).** Every answer came back "Didn't hear
anything". A probe on the live page showed audio flowing (48 kHz, no
zeros) but speech peaking at ~0.005 (RMS ~0.0005), ~25 dB quieter than a
desktop mic and under the 0.006 silence floor. With `autoGainControl: true`
speech is at RMS 0.05–0.08. Android now asks for auto-gain; noise
suppression and echo cancellation stay off everywhere, and desktop keeps
raw audio.

**Touch findings on the phone (2026-10-06):**
- Half the holds were cancelled mid-sentence: the thumb drifted just off
  the 56 px button (release landed on a neighbouring `div`). The button now
  keeps pointer capture, and only letting go far from the press point
  cancels.
- Pressing the mic hid the choices and Submit row, the bottom-anchored bar
  shrank, and the mic moved out from under the finger, which then counted as
  "let go elsewhere". Fixed by the row order above and by measuring from the
  press point.
- WaniKani focuses the answer box on every new question, which brings up
  the keyboard. After the panel's own Next / Submit (and auto-advance or
  auto-submit) a 2.5 s guard takes that focus away again, unless the user
  taps the box. It still comes up sometimes, which the user is fine with as
  long as the panel stays above the keyboard (it does).
- Press to "Listening…" took 4 ms; the felt delay was the cancellations.

**Other Android specifics:**
- Mic permission is asked twice the first time: by Firefox for the site,
  and by Android for Firefox (RECORD_AUDIO).
- Leaving the app hides the tab, which already releases the mic. Android
  may also kill the background page, in which case models reload on
  return (the panel shows "Loading speech model…").
- The download is ~150 MB, stated in the listing for mobile data.
- `commands` doesn't exist there; the background guards the call.

**Testing:**
- **Automated, desktop headless:** emulate a touch-only device (Firefox
  prefs for a coarse primary pointer and no hover) and drive the panel with
  W3C pointer actions of type `touch`. Covers K1–K8, no focus on fill, the
  narrow-screen layout and the wording.
- **Real phone:** `web-ext run -t firefox-android --adb-device … -s build`
  over USB debugging (needs `android-tools` for `adb`, and "Remote debugging
  via USB" in Firefox for Android). It installs into the phone's normal
  Firefox profile (so the WaniKani login is there) as a temporary add-on,
  which loses its data, including a custom model, on every reinstall or
  Firefox restart.
- **Measuring on the phone:** web-ext forwards the Firefox debugging
  protocol to a local TCP port (printed at startup). A small client
  evaluated code in the background page (`listAddons` → `getWatcher` →
  `watchTargets("frame")`, then `evaluateJSAsync`) and in the tab
  (`listTabs` → `getTarget`) to log worker round trips and pointer timings.
  Top-level `await` isn't supported there; store the result in a global and
  read it back.
- **Automated:** 9 touch tests run in a second headless Firefox with
  `ui.primaryPointerCapabilities` / `ui.allPointerCapabilities` = 1 (coarse,
  no hover) and a 412×915 window, using W3C `touch` pointer actions.
- **An emulator** (Android SDK, x86) is possible but not representative
  for ARM speed; not planned.

**Release:**
- Version 0.2.0 with `gecko_android` set. AMO then offers it to Firefox for
  Android users; enable Android in the listing's compatibility settings if
  AMO asks.
- Mobile screenshots: `store/screenshots/6-phone-ready.png`,
  `7-phone-choices.png` (also in the README). Done.
- README and store text updated for Android and Moonshine. Done.

**Decisions (2026-10-06):**
- **Test device: Pixel 9 Pro XL** (Google Tensor G4, 16 GB RAM). Memory is
  unlikely to be the limit on it; for lower-end phones, still keep the lazy
  reading-model load. Speed numbers from it are an upper-mid-range
  reference, not a worst case.
- **Default listening on Android: hold-to-talk** on the mic button.
  Hands-free stays available in the settings.
- **English: Moonshine base as *fast*, the default everywhere** (replacing
  tiny.en); Whisper base.en stays as *accurate*.
- **No pause button; a Clear button on touch screens.**
- **Default panel placement on phones: bottom bar.** The position setting
  still allows the top.

### Phase 7 — Chrome Web Store, desktop (built 2026-10-07; store submission pending)

**Goal:** the same add-on on desktop Chrome (and Chromium-based browsers),
from the same repository: one codebase, a `--target chrome` build, the same
privacy guarantees (nothing leaves the device, never read the question) and
the same tests. Chrome on Android has no extensions, so desktop only.

**What changes** (checked against Chrome's documentation on 2026-10-07):
| Area | Firefox today | Chrome | Plan |
|---|---|---|---|
| Background | Event page (`background.scripts`) that owns the speech `Worker` | MV3 allows only a **service worker**, which can't create dedicated workers and is stopped after ~30 s idle | An **offscreen document** (reason `WORKERS`) hosts the speech worker and keeps the models loaded; offscreen documents with that reason aren't closed automatically. The service worker keeps settings, routing, commands and model choice. Offscreen documents get only the `runtime` API, so they talk to the service worker by messages. The model state moves to the offscreen side, so a restarted service worker loses nothing |
| API namespace | `browser.*` | `chrome.*`, promise-based since Chrome 99; `runtime.onMessage` listeners may return a Promise | A one-line shim (`globalThis.browser ??= chrome`) in each context. No polyfill: the 12 APIs used (`storage`, `runtime.*`, `tabs.create`, `commands`) are all promise-capable in Chrome |
| Manifest | One file, Firefox keys | No `browser_specific_settings` / `data_collection_permissions`; **no SVG icons** | Generated per target by `tools/build.mjs`: `background.service_worker`, an `offscreen` permission, PNG icons (16/32/48/128), `minimum_chrome_version`. Same CSP (`wasm-unsafe-eval`), same host permission |
| Keep-alive | 5 s port heartbeat keeps the event page (and models) alive | Not needed for the models (offscreen); harmless | Kept; it also keeps the service worker warm between answers |
| Microphone | Content script, raw constraints, ScriptProcessor | Same APIs; Chrome applies its own audio processing unless disabled, which our constraints do | Verify raw capture and levels on Chrome (as the Android mic gain was) |
| Custom models | IndexedDB in the extension origin | Same; quota rules differ | Check an 85 MB model installs; add `unlimitedStorage` (no install warning) if needed |
| Toolbar popup | Closes on file chooser; settings open in a tab instead | Popups also close when they lose focus | Same workaround; verify |
| Speed | Single-threaded WASM (no cross-origin isolation in Firefox extensions) | Extension pages can be **cross-origin isolated** (`cross_origin_embedder_policy` / `cross_origin_opener_policy` manifest keys, Chrome 93+) → SharedArrayBuffer → **multi-threaded WASM**. WebGPU on most desktop platforms | Spikes C3/C4: optional speed-ups, Chrome only. Could make Whisper *accurate* fast. Docs don't say whether isolation reaches offscreen documents: measure |

**Decisions (2026-10-07):**
- **Developer account:** you register it when we're ready to list, with a
  walkthrough then.
- **Unlisted first**, then public.
- **No speed work for Chrome** (C3/C4 dropped): Moonshine is already fast
  enough, and both browsers stay on the same single-threaded WASM.
- **Microsoft Edge Add-ons too**, from the same Chrome package.
- **Chromium (with chromedriver) installed** for testing.

**Result (2026-10-07):** built as planned; the whole suite (40 tests)
passes on Firefox and on Chromium 153.
- **C1 passed:** real speech goes content script → service worker →
  offscreen document → speech worker and back. Moonshine decodes in ~160 ms
  in Chromium (~100 ms in Firefox).
- **C2 passed:** `test_service_worker_restart` stops the service worker
  (DevTools `ServiceWorker.stopAllWorkers`); the restarted one finds the
  models still loaded (ready at once) and the next answer works.
- **Design:** `background.js` is unchanged except for one seam: its
  `Worker` comes from `WKV.createSpeechWorker` when present
  (`src/background/offscreen-host.js`, Chrome only), a stand-in that relays
  to the real worker in `src/offscreen/`. `src/background/service-worker.js`
  `importScripts` the same files as Firefox's background page.
- **Found on the way:**
  - Chrome sends extension messages as JSON, which mangles a
    `Float32Array`; audio now travels as base64 in both browsers
    (`src/shared/wire.js`).
  - The background replies with `sendResponse` (returning a Promise only
    works in newer Chrome).
  - Chrome caps a message at 64 MB, too small for the test hook that
    installed custom models by message; it now fetches them itself (test
    build only).
  - Chromium still talks to Google (update, time, accounts) with background
    networking off; the privacy audit allows only those hosts, as it allows
    Mozilla's for Firefox.
  - Chromedriver doesn't keep a touch pointer down across separate action
    calls: one test now does its press in a single action.
  - The settings page said "inside Firefox"; now "inside your browser".
- **Store material:** `store/CHROME-LISTING.md` (listing text, privacy-tab
  answers, reviewer notes, Edge specifics), `PRIVACY.md`, the 440×280 promo
  tile and Edge's 300×300 logo, and a re-rendered settings screenshot
  (`tools/make-store-images.py`; the old one showed tiny.en).
- **Next:** your test of `build-chrome/` (unpacked) in Chromium; then the
  developer account, an unlisted upload, public, and Edge.

**Spikes first** (each a yes/no before building on it):
- **C1. Offscreen speech worker:** offscreen document + transformers.js
  worker + bundled models in Chromium; transcribe a clip from a content
  script; latency and memory vs Firefox.
- **C2. Lifecycle:** stop the service worker (chrome://serviceworker-internals)
  mid-session: next answer still works, models stay loaded, ports reconnect.
- ~~C3. Threads~~ and ~~C4. WebGPU~~: dropped (decision above).

**Build and packaging:**
- `tools/build.mjs --target chrome` → `build-chrome/`: the Chrome manifest,
  the shim, the offscreen page, PNG icons (rendered from `icons/icon.svg`
  like `store/icon-128.png`). Firefox output unchanged.
- `npm run package -- --target chrome` → `dist/…-<version>-chrome.zip`.
  Same policy check (extended to the offscreen page), no signing (the store
  signs). Same version numbers in both stores.
- Optional later: upload through the Chrome Web Store API (OAuth client and
  refresh token, kept in `~/.config/wanikani-voice/`, like the AMO
  credentials).

**Tests:**
- Chromium plus chromedriver from the Arch repos (`chromium` 153). Branded
  Chrome no longer loads unpacked extensions from the command line, so
  Chromium (or Chrome for Testing) is the test browser.
- `test/run_tests.py --browser chrome`: the `Browser` class gets a Chrome
  variant (load the build, preferences, fake mic). The page-level tests
  (state machine, choices, speech, custom models, options) run unchanged;
  Firefox-only ones (idle timeout pref, Android touch emulation) are skipped
  or ported via DevTools touch emulation.
- **Privacy audit on Chrome:** the same refusing proxy, with Chrome's own
  background traffic switched off (`--disable-background-networking`,
  `--disable-component-update`, no pings), so any remaining request would
  have come from the add-on.

**Store listing** (Chrome Web Store, verified 2026-10-07):
- **Developer account:** registered by you (one-time fee, identity details;
  trader or non-trader declaration for the EU).
- **Images:** icon 128×128 PNG (have), **small promo tile 440×280
  (required, new; no text, works on light grey)**, 1–5 screenshots
  1280×800, full bleed. Retake the five desktop shots in Chrome, since the
  settings page renders slightly differently. Marquee 1400×560 optional.
- **Text:** name, a ≤132-character summary (the manifest description),
  the description adapted from the AMO one (Chrome wording, no Android, same
  AI credit), category (Education or Tools), language.
- **Privacy practices tab:**
  - single purpose: "answer WaniKani reviews and lesson quizzes by voice"
  - a justification for each permission (`storage`, `offscreen`, `www.wanikani.com`)
  - remote code: none
  - data usage: nothing collected
  - a **privacy policy URL**: a new `PRIVACY.md` in the repository, which
    AMO can link to as well
- **Distribution:** unlisted first (your own testing on a signed store
  build), then public.

**Phases:**
1. C1 + C2 (the architecture question), then the Chrome build target and shim.
2. Test harness on Chromium; the whole suite green on both browsers.
3. Your test on desktop Chrome, unpacked, then unlisted from the store.
4. Listing assets and privacy policy; submit to the Chrome Web Store
   (unlisted, then public) and to Microsoft Edge Add-ons.

**Risks:**
- Service worker ↔ offscreen messaging adds a hop and lifecycle edge cases (C2).
- Chrome's microphone defaults differ.
- Chrome Web Store review of a 140 MB package with WebAssembly may take longer
  or ask questions; the reviewer notes prepared for AMO apply.
- Two builds to keep in step: one codebase and one test suite run on both.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Misheard answer counts against you | Default is fill-only: you see it before pressing Enter |
| Japanese readings misheard (accent, short readings) | Fill-only default plus up to 3 alternatives to pick from; typing still works. Model accuracy measured in S4 |
| WaniKani DOM changes | Selectors live in two files. If the type can't be read, the badge shows "unsupported" and does nothing |
| Model size vs 200 MB XPI limit | ~148 MB zipped since 2026-10-06 (Moonshine 64, Whisper base.en 77, hiragana 51 MB, runtime) |
| Background unloaded mid-session | Heartbeat (S2); verified by test |
| System noise filters (e.g. EasyEffects) degrade recognition | Extension asks for raw audio. Users with system noise gates will see worse accuracy; worth a note in the listing |
| Your voice recordings | Moved to the private submodule `personal/` (2026-10-04), and removed from the public repo's history by a rewrite. Voice tests skip without the submodule |
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
  inside transformers.js and onnxruntime (unused paths; the CSP forbids eval).
  Since 0.2.0 (`gecko_android` 142) the Android notice is gone; one warning
  remains (onnxruntime-web's dynamic `import()` of its own WASM glue).
- XPI size is ~148 MB, under AMO's 200 MB limit.
- Model licences allow redistribution: Moonshine (MIT), Whisper (MIT),
  Silero VAD (MIT) and distilhubert-hiragana-ctc (Apache-2.0). All are
  listed with the libraries in `THIRD_PARTY_NOTICES.md` (Silero was missing
  until 2026-10-06).
- The add-on ID `wanikani-voice@jsmrcina` is permanent once published. Change
  it now if you'd prefer something else.

---

## 7. Release status (2026-10-05)

- **v0.1.1** is signed by Mozilla (unlisted channel) and published as a
  GitHub release (`v0.1.1`) with the signed `.xpi`, the source zip and
  `SHA256SUMS`. Lesson quizzes and custom models are verified live.
- **No private data is in the public repository or the release.** Checked
  on 2026-10-04:
  - the fine-tuned model's exact content (`73eeb68b…`) and the packed
    `.wkv-model.zip` appear in no LFS object of any commit
  - nothing under `personal/` and no `.wkv-model.zip` was ever committed
  - both the release `.xpi` and the source zip contain only the generic
    reading model (`2e8fdf1c…`)
  - your private data lives only in `wanikani-voice-private` (the
    `personal/` submodule) and in git-ignored `dist/models/`
- **Listed on AMO (submitted 2026-10-05):** v0.1.2 went to the listed
  channel with the summary (crediting Claude Opus 5.5), description,
  category and MIT licence applied. Status: *nominated*, waiting for
  Mozilla's review. The slug is set to `voice-answers-for-wanikani`
  (https://addons.mozilla.org/en-US/firefox/addon/voice-answers-for-wanikani/).
  Screenshots and the icon (`store/screenshots/`, `store/icon-128.png`) are
  uploaded in the Developer Hub.
- **Store listing (prepared 2026-10-04):** `store/amo-metadata.json`
  (summary, description, category Language Support, MIT) and
  `store/LISTING.md` (the same text plus reviewer notes, a privacy
  statement and screenshot captions). `npm run package -- --sign --listed`
  submits to the public store. The listing has the icon, five captioned
  screenshots, the homepage and support links (the GitHub repository) and
  a contributions link (Buy Me a Coffee).
- **Hardware (README → Requirements):** no GPU used: single-core WASM on
  the CPU. Updated 2026-10-06: on a fast desktop CPU English takes ~0.1 s
  (*fast*, Moonshine) or 1.5–1.7 s (*accurate*), readings ~0.4 s, memory
  +430 / +720 MB; on a Pixel 9 Pro XL 0.25–0.4 s, 4–5 s and ~0.5 s. Slower CPUs scale roughly with single-core speed (estimated
  1.5–2.5× on a typical laptop).
- **Personal notes removed (2026-10-05).** Details of the developer's own
  hardware, audio setup and pronunciation were taken out of this file and
  the recorder's comments, and scrubbed from every earlier version in git
  history (`git filter-repo --replace-text`, then a force-push). The
  commit author name and email stay, by choice.
  - The submodule link to `wanikani-voice-private` will be visible once
    the repository is public, but its contents stay private.

## 8. Next steps

1. **English fine-tuning pipeline: built 2026-10-06** (`tools/finetune-moonshine.py`,
   `tools/export-moonshine.py`; custom English models may now be Moonshine).
   On clips never trained on (first choice / offered):

   | | stock Moonshine | **fine-tuned** | Whisper base.en |
   |---|---|---|---|
   | 60 held-out personal clips | 40 / 50 | **46 / 50** | 49 / 55 |
   | 25 real-raw recordings (other words, other day) | 20 / 21 | **23 / 24** | 22 / 25 |
   | decode time (Node) | ~115 ms | ~65 ms | ~320 ms |

   - Training: everything but the encoder's conv stem, lr 1e-5, batch 8,
     the hiragana script's augmentation. Validation peaked at epoch 2
     (16/24 → 23/24) and later epochs overfit. The final model
     (`personal/models/moonshine-base-ft`, packed in `dist/models/`) is
     trained on all 300 clips for 2 epochs; real-raw 23/25 as above.
   - **Trap:** transformers 4.57 gives Moonshine a causal-LM loss that
     shifts the labels a second time (10.7 loss on a clip it gets right,
     0.21 computed correctly). Training with it wrecked the model
     (validation 16/24 → 6/24 in 4 epochs). The script computes the loss
     itself.
   - **Export:** Optimum's export adds attention-mask inputs that
     onnx-community's files don't have and transformers.js doesn't send;
     they become all-ones tensors in the graph. Quantising the merged
     decoder needs `EnableSubgraph` (its layers sit in If branches). The
     stock model exported this way scores within one clip of the shipped
     one (226 vs 227 of 300).
   - Remaining misses are near-homophones (tale/tail, to pour/poor, warm/
     warn) and close sounds; several have the right word as choice 2.

   Steps, as planned:
   - a word list of your WaniKani meanings: done 2026-10-06,
     `tools/wk-meanings.mjs`, 300 meanings (105 short words, 75 phrases,
     120 others), 240 for training and 60 held out
   - recordings with `tools/recorder`: done 2026-10-06, all 300, in the
     private `personal/recordings/en/`
   - **Baseline on those recordings** (`node tools/eval-asr.mjs
     moonshine-base whisper-base.en --personal [all]`), counting where the
     right answer lands among the three choices:

     | | 1st | 2nd | 3rd | not offered |
     |---|---|---|---|---|
     | Moonshine base, all 300 | 223 | 23 | 9 | 45 |
     | Whisper base.en, all 300 | 242 | 27 | 8 | 23 |
     | Moonshine base, 60 held out | 40 | 7 | 3 | 10 |
     | Whisper base.en, 60 held out | 49 | 6 | 0 | 5 |

     Moonshine's gap is mostly short words (right word offered 78/105 vs
     93/105). Unfixable without the question: homophones (tale/tail,
     aid/eight, "to be which"). (Measured before 11 re-recorded clips, 4
     of which then passed with both models.)
   - full fine-tuning of Moonshine base (the default) or whisper-base.en
     in PyTorch; custom English models are Whisper-only so far, so the
     model store needs a `moonshine` kind
   - export via Optimum with int8 quantisation, packed with
     `tools/pack-model.mjs` and chosen in settings → Custom models
   - measured on held-out recordings, as in the Phase 4 results
2. **Training inside the extension** (deferred 2026-10-04). Train only the
   kana head (0.69M weights), in plain JS/WASM, from a recorder in the
   settings page. Clips and weights stay in IndexedDB, and the CTC loss and
   gradients are written by hand, since onnxruntime-web has no training. On
   the benchmark, head-only gets 20/31 offered vs 24/31 for full
   fine-tuning (13/31 generic). Most useful for other users once the add-on
   is public, since they have no personal build.
3. **Android on the public listing: submitted 2026-10-07 as v0.2.3**
   (the same code as the unlisted v0.2.2, tested on the Pixel), with release
   notes, the Android description and the combined phone screenshot
   (`store/screenshots/6-android.png`). Waiting for Mozilla's review, which
   also covers the still-pending v0.1.2.
