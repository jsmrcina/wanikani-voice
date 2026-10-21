# Privacy policy: Voice Answers for WaniKani: Unofficial Tool

Last updated: 2026-10-20. Applies to the extension in every store (Firefox
Add-ons, Chrome Web Store, also used by Microsoft Edge and other Chromium
browsers) and to builds from this repository.

**Voice Answers for WaniKani (an unofficial tool, not affiliated with
WaniKani or Tofugu) collects no data.** It has no servers, no
account, no analytics and no tracking, and it makes no network requests at
all.

## What it handles, and where it stays

| What | How it's used | Where it stays |
|---|---|---|
| Your voice (microphone audio) | Recorded only while you hold the push-to-talk key or the panel's mic button (or, in hands-free mode, while a review question is waiting for an answer), plus the 0.3 seconds just before you pressed (see [The microphone](#the-microphone)). Turned into text by speech models that run inside your browser, then discarded | Your device, in memory only. Never stored, never sent anywhere |
| The recognised answer | Typed into WaniKani's answer box, exactly as you said it | WaniKani's page, like an answer you typed |
| The kind of question | Whether WaniKani asks for a meaning or a reading, read from the page to pick a speech model. The question itself is never read | Your device, in memory only |
| Your settings | Push-to-talk key, panel position, English speed and similar | The browser's local extension storage on your device (not synced) |
| Custom models you choose | Speech model files you load in the settings | The extension's storage on your device |
| A WaniKani dictionary you choose (optional) | A file of WaniKani meanings and readings you make yourself with the project's `tools/wk-dictionary.mjs` and your own API token, outside the extension. Used only to put answers that are WaniKani words first | The browser's local extension storage on your device. The extension never contacts WaniKani's API and never sees your token |
| WaniKani's quiz state, when you ignore a wrong answer (optional) | With *Offer to ignore a wrong answer* on, a small script in the review page takes back a wrong answer you ask to ignore: it restores the count and queue position WaniKani changed for it, inside the page. Nothing about the question or the answer is passed to the rest of the extension | WaniKani's page, in memory |

## The microphone

By default the microphone stays **open between answers** while you're on a
WaniKani review or lesson quiz page, from the first time you press the
push-to-talk key or the panel's mic button. Your browser shows its
microphone-in-use indicator for as long as it's open. It's closed when you
pause voice answers, when the tab is hidden (another tab, a minimised window,
or on a phone another app or the screen turned off) and when you leave the
page.

**Why it stays open:** so the start of your answer isn't cut off. Opening a
microphone takes a moment, and people often start speaking as they press. To
catch that first syllable (the *h* of "hand"), the extension keeps the last
0.3 seconds of sound and puts it in front of your recording when you press.

**What happens to the sound while you're not pressing anything:**
- It goes into a **circular buffer** in memory that holds only the last 0.3
  seconds and is **constantly overwritten**. Anything older is gone.
- Its loudness is measured, to tell speech from the room's background noise.
- **It is never used otherwise.** Nothing reaches the speech models unless
  you press, and the buffer is never saved to disk or storage.
- **Nothing is sent anywhere:** the extension makes no network requests at
  all (see [Permissions](#permissions)).

**Turning it off:** in the settings, untick *Keep the microphone open between
answers*. The microphone then opens only while you hold the key or the mic
button and closes as soon as you let go. The trade-off: your first syllable
may be clipped if you start speaking right after pressing.

**Hands-free mode** is different by design: there the extension listens
continuously, through the same open microphone, for you to start speaking.

The speech models ship inside the extension. Nothing is downloaded while
you use it, and the extension's content security policy blocks network
access from its own pages.

## Permissions

- **Access to www.wanikani.com:** to show the panel on review and lesson
  quiz pages, read the kind of question and fill in the answer box, and
  (only with the ignore setting on) to take back a wrong answer.
- **Storage:** to keep your settings, custom models and dictionary on your device.
- **Offscreen document (Chrome and other Chromium browsers only):** to run the speech
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
