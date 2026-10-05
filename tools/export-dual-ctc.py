"""Exports the kana head of a "dual CTC" hiragana model (TylorShine's
DualCTCModel: a HuBERT/WavLM encoder with kana and phoneme CTC heads) to ONNX,
in a form transformers.js loads as HubertForCTC (input `input_values`, output
`logits`), plus a partly 8-bit quantised copy. The kana vocabulary goes into
config.json (`kana_vocab`), which transformers.js loads with the model.

Dev-time only (needs torch, transformers, onnxruntime, huggingface_hub):
    python tools/export-dual-ctc.py REPO REVISION OUT_DIR
    python tools/export-dual-ctc.py LOCAL_CHECKPOINT_DIR - OUT_DIR   (fine-tuned)

The repo's custom model code runs (trust_remote_code) at the pinned revision;
reviewed 2026-10-04: an encoder plus two small linear heads, nothing else.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModel


class KanaHead(torch.nn.Module):
    def __init__(self, dual):
        super().__init__()
        self.dual = dual

    def forward(self, input_values):
        return self.dual(input_values)["kana_logits"]


def main():
    repo, revision, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    src = Path(repo) if Path(repo).is_dir() else Path(snapshot_download(repo, revision=revision))
    dual = AutoModel.from_pretrained(src, trust_remote_code=True).eval()
    (out / "onnx").mkdir(parents=True, exist_ok=True)

    dummy = torch.zeros(1, 16000)
    torch.onnx.export(
        KanaHead(dual), (dummy,), str(out / "onnx/model.onnx"),
        input_names=["input_values"], output_names=["logits"],
        dynamic_axes={"input_values": {1: "samples"}, "logits": {1: "frames"}},
        opset_version=17, dynamo=False,
    )
    # Only the transformer's MatMuls, per-channel signed int8. Quantising the
    # convolutional front end as well (24 MB) cost 10/25 -> 5/25 on real
    # readings; this keeps fp32 accuracy (99.9% frame agreement) at 51 MB.
    quantize_dynamic(out / "onnx/model.onnx", out / "onnx/model_quantized.onnx",
                     op_types_to_quantize=["MatMul"], weight_type=QuantType.QInt8, per_channel=True)

    # Check the export against PyTorch on a random-ish signal.
    x = torch.from_numpy(np.random.default_rng(0).standard_normal((1, 24000)).astype(np.float32) * 0.05)
    with torch.inference_mode():
        ref = KanaHead(dual)(x).numpy()
    got = ort.InferenceSession(str(out / "onnx/model.onnx")).run(None, {"input_values": x.numpy()})[0]
    print(f"export check: max |diff| = {np.abs(ref - got).max():.2e}, argmax agree = "
          f"{(ref.argmax(-1) == got.argmax(-1)).mean():.3f}")

    kana_tok = json.loads((src / "kana_tokenizer/tokenizer.json").read_text(encoding="utf-8"))
    vocab = {i: t for t, i in kana_tok["model"]["vocab"].items()}
    for t in kana_tok.get("added_tokens", []):
        vocab[t["id"]] = t["content"]
    size = max(vocab) + 1
    # Just enough config for transformers.js to load the graph as HubertForCTC.
    (out / "config.json").write_text(json.dumps({
        "model_type": "hubert",
        "architectures": ["HubertForCTC"],
        "vocab_size": size,
        "source": {"repo": repo, "revision": revision, "head": "kana_logits"},
        "kana_vocab": {"blank": 0, "tokens": [vocab.get(i, "") for i in range(size)]},
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for f in sorted(out.rglob("*")):
        if f.is_file():
            print(f"{f.stat().st_size / 1e6:8.1f} MB  {f.relative_to(out)}")


if __name__ == "__main__":
    main()
