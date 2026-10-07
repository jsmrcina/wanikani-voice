# Privacy policy: Voice Answers for WaniKani

Last updated: 2026-10-07. Applies to the extension in every store (Firefox
Add-ons, Chrome Web Store, Microsoft Edge Add-ons) and to builds from this
repository.

**Voice Answers for WaniKani collects no data.** It has no servers, no
account, no analytics and no tracking, and it makes no network requests at
all.

## What it handles, and where it stays

| What | How it's used | Where it stays |
|---|---|---|
| Your voice (microphone audio) | Recorded only while you hold the push-to-talk key or the panel's mic button (or, in hands-free mode, while a review question is waiting for an answer). Turned into text by speech models that run inside your browser, then discarded | Your device, in memory only. Never stored, never sent anywhere |
| The recognised answer | Typed into WaniKani's answer box, exactly as you said it | WaniKani's page, like an answer you typed |
| The kind of question | Whether WaniKani asks for a meaning or a reading, read from the page to pick a speech model. The question itself is never read | Your device, in memory only |
| Your settings | Push-to-talk key, panel position, English speed and similar | The browser's local extension storage on your device (not synced) |
| Custom models you choose | Speech model files you load in the settings | The extension's storage on your device |

The speech models ship inside the extension. Nothing is downloaded while
you use it, and the extension's content security policy blocks network
access from its own pages.

## Permissions

- **Access to www.wanikani.com:** to show the panel on review and lesson
  quiz pages, read the kind of question and fill in the answer box.
- **Storage:** to keep your settings and custom models on your device.
- **Offscreen document (Chrome and Edge only):** to run the speech
  recognition worker in the background of the browser.
- **Microphone:** asked for by the browser for www.wanikani.com when you
  first use push-to-talk.

## Third parties

None. No data is shared with, sold to, or received from anyone. WaniKani
(Tofugu LLC) sees only what any answer typed into its page shows: the answer
text.

## Contact and source

The extension is open source:
https://github.com/jsmrcina/wanikani-voice. Questions or concerns: open an
issue there.
