# WaniKani Voice — Plan

A Firefox extension that lets you answer WaniKani reviews by voice. Speech
recognition runs entirely on-device.

Status (2026-10-04): **Phase 3 done, pending a live check on WaniKani.**
English answers are recognised by Whisper base.en, and Japanese readings by a
small hiragana CTC model. For readings, the badge offers up to three kana
readings it heard (keys 1–3). All of it runs on-device, from push-to-talk or
hands-free speech, end to end in Firefox against the mock review page.

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
| 0 — Spikes S1–S5 | S1 done except the live smoke test. **S2, S4 and S5 done** (findings below). S3 needs the live test |
| **1 — Skeleton with fake ASR** | **Done 2026-10-04** |
| **2 — Audio + English** | **Done 2026-10-04**, pending a live check on WaniKani |
| **3 — Japanese** | **Done 2026-10-04**, pending a live check on WaniKani |
| **4 — UX and robustness** | In progress: VAD, speed, retry limit, correct-only advance and panel position done; fine-tuning pipeline built, waiting on your recordings |
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

### Phase 4 — UX and robustness (in progress, 2026-10-04)
Your decisions: the tuned model ships in a **personal build** only; the training
list comes from **your WaniKani items**; VAD and speed are done while you
record.

- **Fine-tuning on your voice (pipeline built; waiting on recordings).**
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
  - Both tuned models turn the "um" noise clip into kana (あんうん): a
    Japanese hum filter is still needed.
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
- **AMO packaging script:** builds the `.xpi` to upload, plus the source
  archive and build instructions that AMO review needs for the bundled
  worker. It runs `web-ext lint`, checks the size against the 200 MB limit,
  and excludes personal/test data.
- **README rewrite:** a detailed description of how the implementation works,
  with an embedded Mermaid diagram of how data flows through the add-on.
- **Before making the repository public:** history was rewritten on
  2026-10-04 (`git filter-repo`) to remove `test/fixtures/audio/real*`
  (your voice), and a fresh clone has no trace of them. But GitHub keeps
  LFS objects that are no longer referenced, so the old WAVs are still
  stored there. To publish: delete the GitHub repository and push this
  history to a new one (or ask GitHub Support to purge the LFS objects).
  `personal/` stays a private submodule.
- **Lessons** (requested 2026-10-04): support the lesson quiz as well as
  reviews. It uses the same quiz UI (`quiz-input`), so most of the work is
  extending `pageReader.isReviewPage` to the lesson-quiz URLs and checking
  the live markup and events there (as in S1).

Network Monitor + `about:networking` audit over a full session. `web-ext lint`.
Sign as unlisted on AMO, or list publicly (§6).

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Misheard answer counts against you | Default is fill-only: you see it before pressing Enter |
| Japanese readings misheard (accent, short readings) | Fill-only default plus up to 3 alternatives to pick from; typing still works. Model accuracy measured in S4 |
| WaniKani DOM changes | Selectors live in two files. If the type can't be read, the badge shows "unsupported" and does nothing |
| Model size vs 200 MB XPI limit | ~152 MB today (77 + 51 MB models, 27 MB runtime) |
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
  inside transformers.js and onnxruntime (unused paths; the CSP forbids eval)
  and an Android min-version notice.
- XPI size today is ~152 MB, under AMO's 200 MB limit.
- Model licences allow redistribution: Whisper (MIT) and
  distilhubert-hiragana-ctc (Apache-2.0). Both are listed with the libraries
  in `THIRD_PARTY_NOTICES.md`.
- The add-on ID `wanikani-voice@jsmrcina` is permanent once published. Change
  it now if you'd prefer something else.

---

## 7. Open questions

1. **Fine-tuning:** how to ship a voice-adapted model (personal build vs
   in-browser adaptation), and when to record the training set.
2. **Phase 4 order:** fine-tuning first, or Silero VAD / English alternatives.
