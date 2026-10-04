"""Exports a Hugging Face CTC speech model (wav2vec2 / HuBERT / WavLM) to ONNX
in the layout transformers.js loads, plus an 8-bit dynamically quantised copy.

Dev-time only (needs torch, transformers, optimum-onnx, onnxruntime):
    python tools/export-ctc.py REPO REVISION OUT_DIR

Writes OUT_DIR/{config,preprocessor_config,tokenizer_config,special_tokens_map}.json,
vocab.json, onnx/model.onnx and onnx/model_quantized.onnx.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic


def main():
    repo, revision, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    # optimum-cli has no --revision: fetch the pinned snapshot first.
    src = snapshot_download(repo, revision=revision)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([
            str(Path(sys.executable).with_name("optimum-cli")), "export", "onnx",
            "--model", src,
            "--task", "automatic-speech-recognition", "--opset", "17", tmp,
        ], check=True)
        tmp = Path(tmp)
        (out / "onnx").mkdir(parents=True, exist_ok=True)
        for f in tmp.iterdir():
            if f.suffix == ".json" or f.name.endswith(".txt"):
                shutil.copy(f, out / f.name)
        shutil.copy(tmp / "model.onnx", out / "onnx/model.onnx")
        extra = tmp / "model.onnx_data"
        if extra.exists():
            raise SystemExit("external weights file: model too large for a single ONNX file")
    # Weights-only int8; activations stay float (what transformers.js calls "q8").
    quantize_dynamic(out / "onnx/model.onnx", out / "onnx/model_quantized.onnx",
                     weight_type=QuantType.QUInt8)
    for f in sorted(out.rglob("*")):
        if f.is_file():
            print(f"{f.stat().st_size / 1e6:8.1f} MB  {f.relative_to(out)}")


if __name__ == "__main__":
    main()
