"""Exports a fine-tuned Moonshine checkpoint (tools/finetune-moonshine.py) in
the form the extension loads, the same as the bundled models/moonshine-base:
    python tools/export-moonshine.py personal/models/moonshine-base-ft
writes <dir>/onnx/{encoder_model,decoder_model_merged}_quantized.onnx and the
config and tokenizer files next to <dir>/checkpoint, ready for
    node tools/pack-model.mjs <dir> --language en --name "My voice (English)"

Steps (validated 2026-10-06: the stock model exported this way scores within
one clip of onnx-community's on 300 recordings, 226 vs 227 first choice):
1. Optimum's ONNX export (automatic-speech-recognition-with-past), which
   merges the two decoders into decoder_model_merged.onnx.
2. Its attention-mask inputs replaced by all-ones tensors computed in the
   graph. onnx-community's export has no masks and transformers.js sends
   none; a single unpadded clip needs all ones anyway.
3. Dynamic uint8 quantisation, per tensor, of MatMul and Gather (Conv stays
   float), inside the decoder's If branches too: onnx-community's recipe.
4. Configs and tokenizer copied from the bundled model (same architecture).
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import onnx
from onnx import TensorProto, helper
from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "models/moonshine-base"
CONFIG_FILES = ("config.json", "generation_config.json", "preprocessor_config.json",
                "tokenizer.json", "tokenizer_config.json")


def mask_to_ones(graph, mask, like, dims):
    """Replaces graph input `mask` by ones shaped like `like` (its first
    `dims` dimensions, or all)."""
    inp = next(i for i in graph.input if i.name == mask)
    dtype = inp.type.tensor_type.elem_type
    graph.input.remove(inp)
    nodes = [helper.make_node("Shape", [like], [f"{mask}_shape_full"])]
    shape = f"{mask}_shape_full"
    if dims is not None:
        nodes += [
            helper.make_node("Constant", [], [f"{mask}_starts"], value=helper.make_tensor("s", TensorProto.INT64, [1], [0])),
            helper.make_node("Constant", [], [f"{mask}_ends"], value=helper.make_tensor("e", TensorProto.INT64, [1], [dims])),
            helper.make_node("Slice", [shape, f"{mask}_starts", f"{mask}_ends"], [f"{mask}_shape"]),
        ]
        shape = f"{mask}_shape"
    nodes.append(helper.make_node("ConstantOfShape", [shape], [mask], value=helper.make_tensor("one", dtype, [1], [1])))
    for n in reversed(nodes):
        graph.node.insert(0, n)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = (ROOT / sys.argv[1]).resolve()
    ckpt = out / "checkpoint"
    if not (ckpt / "config.json").exists():
        sys.exit(f"no checkpoint in {ckpt} (run tools/finetune-moonshine.py first)")
    with tempfile.TemporaryDirectory(prefix="wkv-moonshine-") as tmp:
        tmp = Path(tmp)
        optimum_cli = Path(sys.executable).with_name("optimum-cli")
        subprocess.run([str(optimum_cli), "export", "onnx", "--model", str(ckpt),
                        "--task", "automatic-speech-recognition-with-past", str(tmp / "fp32")], check=True)
        enc = onnx.load(tmp / "fp32/encoder_model.onnx")
        mask_to_ones(enc.graph, "attention_mask", "input_values", None)
        onnx.save(enc, tmp / "encoder_model.onnx")
        dec = onnx.load(tmp / "fp32/decoder_model_merged.onnx")
        mask_to_ones(dec.graph, "encoder_attention_mask", "encoder_hidden_states", 2)
        onnx.save(dec, tmp / "decoder_model_merged.onnx")
        (out / "onnx").mkdir(parents=True, exist_ok=True)
        for name in ("encoder_model", "decoder_model_merged"):
            onnx.checker.check_model(str(tmp / f"{name}.onnx"))
            quantize_dynamic(str(tmp / f"{name}.onnx"), str(out / "onnx" / f"{name}_quantized.onnx"),
                             weight_type=QuantType.QUInt8, per_channel=False, reduce_range=False,
                             op_types_to_quantize=["MatMul", "Gather"], extra_options={"EnableSubgraph": True})
    for f in CONFIG_FILES:
        shutil.copy(REFERENCE / f, out / f)
    print(f"exported to {out.relative_to(ROOT)}; check it with:\n"
          f"  node tools/eval-asr.mjs {out.name} --models-root {out.parent.relative_to(ROOT)} --personal")


if __name__ == "__main__":
    main()
