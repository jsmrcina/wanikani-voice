# Third-party notices

The extension bundles the following third-party software and models. Each
remains under its own licence. Versions and pinned revisions are in
`package-lock.json` and `models/models.json`.

| Component | Use | Licence | Source |
|---|---|---|---|
| Transformers.js (`@huggingface/transformers` 4.3.0) | Model loading and inference in the worker | Apache-2.0 | https://github.com/huggingface/transformers.js |
| ONNX Runtime Web (`onnxruntime-web`) | WASM inference runtime (`vendor/ort/`) | MIT | https://github.com/microsoft/onnxruntime |
| Whisper base.en (ONNX export by onnx-community) | English speech recognition | MIT (OpenAI) | https://huggingface.co/onnx-community/whisper-base.en |
| distilhubert-hiragana-ctc by TylorShine (ONNX export made by `tools/export-dual-ctc.py`, kana head only, partly int8) | Japanese reading recognition | Apache-2.0 | https://huggingface.co/TylorShine/distilhubert-hiragana-ctc |
| DistilHuBERT (base of the above) | | Apache-2.0 | https://huggingface.co/ntu-spml/distilhubert |
| Noto Sans CJK JP Black (the あ in `icons/icon.svg`, as an outline) | Icon artwork | SIL Open Font License 1.1 | https://github.com/notofonts/noto-cjk |

The hiragana model was modified: converted to ONNX, only its kana CTC head
kept, its transformer MatMul weights quantised to 8 bits, and its kana
vocabulary embedded in `config.json`.
