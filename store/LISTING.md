# Store listing (addons.mozilla.org)

What a **listed** submission needs. `store/amo-metadata.json` holds the
same text in the format AMO's submission API takes; `npm run package --
--sign --listed` sends it. If AMO's Developer Hub asks for listing details
instead (for example because the add-on already exists as unlisted), copy
them from here.

## Basics
| Field | Value |
|---|---|
| Name | Voice Answers for WaniKani (from the manifest) |
| Add-on URL slug | `voice-answers-for-wanikani` |
| Category | Language Support |
| Licence | MIT |
| Requires payment | No |
| Homepage / support site | The GitHub repository, once it's public (https://github.com/jsmrcina/wanikani-voice) |
| Support email | Optional; leave blank, or use a dedicated address |
| Tags (optional) | `japanese`, `wanikani`, `speech recognition`, `voice`, `language learning`, `accessibility` |

## Summary (max 250 characters)
Answer WaniKani reviews and lesson quizzes by voice, on desktop or Android. Speech recognition runs entirely on your device; nothing is sent anywhere. Hiragana readings and English meanings. Created with AI: Anthropic's Claude Opus 5.5.

## Description
Say your WaniKani answers instead of typing them. Hold Shift (or, on a phone, the mic button), say the meaning or the reading, and release: the answer is filled into WaniKani's answer box, ready for you to submit.

<b>Private by design</b>
• Speech recognition runs inside Firefox on your own computer or phone. Your voice is never sent anywhere: the extension makes no network requests at all, and its speech models ship inside the add-on.
• It never reads the question. It only checks whether WaniKani is asking for a meaning or a reading, so a wrong answer goes in exactly as you said it.
• No account, no tracking, no data collection. Permissions: WaniKani pages and local storage only.

<b>Features</b>
• English meanings and radical names (Moonshine, fast, by default; or OpenAI Whisper, accurate).
• Readings in hiragana, from a speech model that writes kana directly, so it never has to guess a reading from kanji.
• Alternatives: if it also heard something else (hand / and, じん / にん), press 1–3 (or tap) to switch before submitting.
• Push-to-talk (Shift, configurable) or hands-free.
• Fill only, or fill and submit; optional auto-advance (or only after a correct answer).
• Works in reviews and lesson quizzes.
• Firefox for Android: everything works by touch (hold the mic button to talk; Submit, Clear and Next buttons), and the panel stays above the on-screen keyboard.
• Advanced: load your own fine-tuned model per language. Tools to fine-tune on your own voice are in the source repository.

<b>Requirements</b>
No GPU needed: everything runs on the CPU. On a fast desktop answers take about 0.1 s (English, fast), 1.5 s (English, accurate) and 0.4 s (readings); on a Pixel 9 Pro XL about 0.3 s, 4 s and 0.5 s. The models use about 430 MB of memory while a review is open (720 MB with accurate English). Firefox 140+ on desktop, 142+ on Android; the download is about 150 MB. Avoid system noise gates or suppressors on the microphone (e.g. EasyEffects): they cut off the start of words.

<b>Notes</b>
Not affiliated with WaniKani or Tofugu. Open source (MIT). This extension was created with AI: all of its code was written by Anthropic's Claude Opus 5.5 (in Claude Code), directed and tested by a human.

## Privacy policy
Not required: the add-on collects and transmits no data
(`data_collection_permissions: none`). If AMO asks anyway, this is enough:

> Voice Answers for WaniKani does not collect, store or transmit any personal
> data. Speech is processed on your own computer, inside Firefox, and is
> discarded after recognition. Settings and any custom model you choose are
> stored locally in the extension's own storage. The extension makes no
> network requests.

## Notes to reviewer
Paste into "Notes to Reviewer" when submitting:

> The package contains one bundled file, `dist/asr-worker.js`: our
> `src/worker/*.js` bundled by esbuild (not minified) with
> @huggingface/transformers 4.3.0 and onnxruntime-web. The source archive
> is attached; `npm ci && npm run build` reproduces `build/`, and our
> packaging script verifies the rebuild matches file for file. See
> SOURCE-README.md.
>
> `vendor/ort/` is onnxruntime-web's WASM runtime, unmodified. `models/`
> holds ONNX speech models (Moonshine base and Whisper base.en, MIT; a hiragana
> speech model, Apache-2.0; Silero VAD, MIT), loaded from inside the
> package. Remote loading is disabled and the CSP is `connect-src 'self'`.
>
> Permissions: `storage` (settings) and `https://www.wanikani.com/*`
> (the content script that fills the answer box). The microphone is
> requested from the WaniKani page only when the user presses the
> push-to-talk key. `wasm-unsafe-eval` is needed for WebAssembly
> inference.
>
> The remaining lint warnings: a dynamic `import()` with a computed URL
> in the bundle (onnxruntime-web loading its own WASM glue file from inside
> the package; remote URLs are blocked by the CSP), and
> `data_collection_permissions` not being supported on Android (desktop
> only).

## Icon
`store/icon-128.png` (128×128, rendered from `icons/icon.svg`) for the
listing's icon in the Developer Hub (Edit Product Page → Images).

## Screenshots
Ready in `store/screenshots/` (1280×800 PNG, upload in this order). They were
made from real captures, cropped to leave out the header
statistics, with the panel enlarged 2×; the settings shot is rendered from
the real settings page.

| File | Caption |
|---|---|
| `1-listening.png` | Hold Shift and say the answer: the panel turns red while it listens |
| `2-recognising.png` | Recognised on your own computer; speech never leaves Firefox |
| `3-filled-in.png` | The answer is filled in; check it and press Enter |
| `4-reading-choices.png` | Readings in hiragana; press 1–3 if it heard a different reading |
| `5-settings.png` | Push-to-talk or hands-free, auto-submit, auto-advance, English speed, custom models |
| `6-phone-ready.png` | On a phone: hold the mic button and say the answer |
| `7-phone-choices.png` | On a phone: tap a reading, then Submit (or Clear) |

The two phone screenshots (1008×2244, portrait, uncropped, taken on a Pixel 9
Pro XL on 2026-10-06) are for the Android release.

## Before submitting a listed version
- **Make the GitHub repository public** first (see PLAN.md: personal notes
  and authorship), so the homepage and source links work. Do it before
  submitting, because AMO reviewers may follow links.
- **Bump the version:** every submission needs a new one (unlisted 0.1.0
  and 0.1.1 are taken).
- **Expect review time:** listed add-ons get the same automated review
  plus possible human review, typically within days.
