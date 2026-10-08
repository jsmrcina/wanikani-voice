# Store listing: Chrome Web Store

What a submission to the Chrome Web Store needs. It takes the
package `npm run package -- --target chrome` →
`dist/voice-answers-for-wanikani-<version>-chrome.zip` (built from
`build-chrome/`, see PLAN.md Phase 7), and signs it itself: there is no
source archive or signing step. The Firefox listing is in `LISTING.md`.

Plan (decided 2026-10-07): **unlisted first** on the Chrome Web Store for a
test install from the store, then public.

Status: **v0.2.6 submitted to the Chrome Web Store, unlisted, on 2026-10-07**
(in review).

**Microsoft Edge Add-ons: dropped (2026-10-07).** Its developer registration
requires a contact address that is shown publicly on the developer profile,
and you don't want to publish a home address. Edge users install from the Chrome Web Store: Edge runs Chrome extensions and, on the store's page, offers to "Allow extensions from other stores".
Only discoverability inside Edge's own store is lost.

## Accounts (you, once)
- **Chrome Web Store:** register a developer account at
  https://chrome.google.com/webstore/devconsole with a Google account: a
  one-time registration fee, contact email verification, and the EU
  trader / non-trader declaration (a free hobby project is normally
  non-trader). Then "New item" and upload the zip.

## Package tab
- Upload `dist/voice-answers-for-wanikani-<version>-chrome.zip` (~140 MB;
  the Chrome Web Store allows up to 2 GB).
- Same version number as the Firefox release.

## Store listing tab
| Field | Value |
|---|---|
| Name | Voice Answers for WaniKani (from the manifest) |
| Summary (≤ 132 characters, from the manifest) | Answer WaniKani reviews by voice. Speech recognition runs entirely on your device. |
| Category | Education |
| Language | English |
| Homepage / support | https://github.com/jsmrcina/wanikani-voice (issues for support) |
| Icon | `store/icon-128.png` (also in the package) |
| Small promo tile (required) | `store/promo-440x280.png` (`tools/make-store-images.py`) |
| Screenshots (1280×800, up to 5) | `store/screenshots/1-listening.png`, `2-recognising.png`, `3-filled-in.png`, `4-reading-choices.png`, `5-settings.png` |
| Marquee (optional) | none |

Screenshots 1–4 show only the WaniKani page and the panel, which look the
same in Chrome; 5 is the settings page rendered in Chromium. The Chrome Web
Store has no per-screenshot captions.

### Description (plain text)
```
Say your WaniKani answers instead of typing them. Hold Shift, say the meaning or the reading, and release: the answer is filled into WaniKani's answer box, ready for you to submit.

PRIVATE BY DESIGN
• Speech recognition runs inside your browser, on your own computer. Your voice is never sent anywhere: the extension makes no network requests at all, and its speech models ship inside the extension.
• It never reads the question. It only checks whether WaniKani is asking for a meaning or a reading, so a wrong answer goes in exactly as you said it.
• No account, no tracking, no data collection.

FEATURES
• English meanings and radical names (Moonshine, fast, by default; or OpenAI Whisper, accurate).
• Readings in hiragana, from a speech model that writes kana directly, so it never has to guess a reading from kanji.
• Alternatives: if it also heard something else (hand / and, じん / にん), press 1–3 or click to switch before submitting.
• Push-to-talk (Shift, configurable) or hands-free; the panel's mic button also works (hold it to talk).
• Fill only, or fill and submit; optional auto-advance (or only after a correct answer).
• Works in reviews and lesson quizzes.
• Advanced: load your own fine-tuned model per language. Tools to fine-tune on your own voice are in the source repository.

REQUIREMENTS
No GPU needed: everything runs on the CPU. On a fast desktop answers take about 0.1 s (English, fast), 1.5 s (English, accurate) and 0.4 s (readings); slower computers take longer. The models use about 430 MB of memory while a review is open (720 MB with accurate English). Chrome 116 or newer; the download is about 140 MB. Avoid system noise gates or suppressors on the microphone: they cut off the start of words.

NOTES
Not affiliated with WaniKani or Tofugu. Open source (MIT): https://github.com/jsmrcina/wanikani-voice. This extension was created with AI: all of its code was written by Anthropic's Claude Opus 5.5 (in Claude Code), directed and tested by a human.
```

## Privacy practices tab (Chrome Web Store)
| Field | Answer |
|---|---|
| Single purpose | Lets you answer WaniKani reviews and lesson quizzes by speaking: it recognises your spoken answer on your device and fills it into WaniKani's answer box. |
| `storage` justification | Keeps your settings (push-to-talk key, panel position, English speed) and any custom speech model you choose, locally on your device. |
| `offscreen` justification | The speech recognition worker (WebAssembly models) runs in an offscreen document, because a Manifest V3 service worker can't start workers and is stopped when idle; the offscreen document keeps the models loaded during a review session. |
| Host permission (`https://www.wanikani.com/*`) justification | Shows the voice panel on WaniKani review and lesson quiz pages, reads only whether a meaning or a reading is asked for, and fills the recognised answer into the answer box. No other site is accessed. |
| Remote code | No, I am not using remote code. All code and models are in the package; the CSP allows WebAssembly (`wasm-unsafe-eval`) only for the bundled speech models. |
| Data usage | Collects none of the listed data types. (Audio is processed on the device and discarded; nothing is transmitted.) |
| Certifications | Tick all three: not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending. |
| Privacy policy URL | https://github.com/jsmrcina/wanikani-voice/blob/main/PRIVACY.md |

## Distribution tab
- Payments: free.
- Visibility: **Unlisted** for the first version (installable from its link,
  not searchable); switch to Public after testing the store build.
- Regions: all.

## Notes for the reviewer ("Test instructions")
```
The extension needs a WaniKani account with reviews or lessons available (wanikani.com, free levels 1-3 are enough). On a review page, hold Shift and say an answer (e.g. "fire"); the recognised text is filled into the answer box. Settings: toolbar button.

Everything runs locally: the speech models (ONNX, in models/) and onnxruntime-web's WebAssembly runtime (vendor/ort/, unmodified) are inside the package; dist/asr-worker.js is our src/worker code bundled with @huggingface/transformers 4.3.0 and onnxruntime-web by esbuild, unminified. Source: https://github.com/jsmrcina/wanikani-voice (build: npm ci && node tools/build.mjs --target chrome). The extension makes no network requests; CSP connect-src 'self'. The offscreen document only hosts the speech worker.
```

