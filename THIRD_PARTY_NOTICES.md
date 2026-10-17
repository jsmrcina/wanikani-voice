# Third-party notices

The extension bundles the following third-party software and models. Each
remains under its own licence. Versions and pinned revisions are in
`package-lock.json` and `models/models.json`.

| Component | Use | Licence | Source |
|---|---|---|---|
| Transformers.js (`@huggingface/transformers` 4.3.0) | Model loading and inference in the worker | Apache-2.0 | https://github.com/huggingface/transformers.js |
| ONNX Runtime Web (`onnxruntime-web`) | WASM inference runtime (`vendor/ort/`) | MIT | https://github.com/microsoft/onnxruntime |
| Moonshine base (ONNX export by onnx-community) | English speech recognition (*fast*, the default) | MIT (Useful Sensors) | https://huggingface.co/onnx-community/moonshine-base-ONNX |
| Whisper base.en (ONNX export by onnx-community) | English speech recognition (*accurate*) | MIT (OpenAI) | https://huggingface.co/onnx-community/whisper-base.en |
| Silero VAD (ONNX export by onnx-community) | Speech detection (is there speech in a clip?) | MIT (Silero Team) | https://huggingface.co/onnx-community/silero-vad |
| distilhubert-hiragana-ctc by TylorShine (ONNX export made by `tools/export-dual-ctc.py`, kana head only, partly int8) | Japanese reading recognition | Apache-2.0 | https://huggingface.co/TylorShine/distilhubert-hiragana-ctc |
| DistilHuBERT (base of the above) | | Apache-2.0 | https://huggingface.co/ntu-spml/distilhubert |
| CMU Pronouncing Dictionary (`src/shared/homophones.js` is derived from it by `tools/make-homophones.py`) | Which English words sound alike | BSD-2-Clause (Carnegie Mellon University) | https://github.com/cmusphinx/cmudict |
| SCOWL 2020.12.07 (word lists, used to keep only common words in `src/shared/homophones.js`) | | Permissive (Kevin Atkinson and others; notice below) | http://wordlist.aspell.net/ |
| Noto Sans CJK JP Black (the あ in `icons/icon.svg`, as an outline) | Icon artwork | SIL Open Font License 1.1 | https://github.com/notofonts/noto-cjk |

The hiragana model was modified: converted to ONNX, only its kana CTC head
kept, its transformer MatMul weights quantised to 8 bits, and its kana
vocabulary embedded in `config.json`.

## CMU Pronouncing Dictionary

```
Copyright (C) 1993-2015 Carnegie Mellon University. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
   The contents of this file are deemed to be source code.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.

This work was supported in part by funding from the Defense Advanced
Research Projects Agency, the Office of Naval Research and the National
Science Foundation of the United States of America, and by member
companies of the Carnegie Mellon Sphinx Speech Consortium. We acknowledge
the contributions of many volunteers to the expansion and improvement of
this dictionary.

THIS SOFTWARE IS PROVIDED BY CARNEGIE MELLON UNIVERSITY ``AS IS'' AND
ANY EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL CARNEGIE MELLON UNIVERSITY
NOR ITS EMPLOYEES BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## SCOWL

```
The collective work is Copyright 2000-2018 by Kevin Atkinson as well
as any of the copyrights mentioned below:

  Copyright 2000-2018 by Kevin Atkinson

  Permission to use, copy, modify, distribute and sell these word
  lists, the associated scripts, the output created from the scripts,
  and its documentation for any purpose is hereby granted without fee,
  provided that the above copyright notice appears in all copies and
  that both that copyright notice and this permission notice appear in
  supporting documentation. Kevin Atkinson makes no representations
  about the suitability of this array for any purpose. It is provided
  "as is" without express or implied warranty.
```

The full SCOWL copyright file, covering its sources, is at
http://wordlist.aspell.net/scowl-readme/.
