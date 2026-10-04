"""Generates icons/icon.svg: a microphone with an overlapping hiragana あ.

    python tools/make-icon.py [--font PATH]   (needs fontTools)

The あ is converted to an outline (no font needed at render time). It comes
from Noto Sans CJK JP Black (SIL Open Font License 1.1, which permits using
glyph outlines in a logo). A stroke painted with the background gradient
"knocks out" a gap where the あ overlaps the microphone.
"""
import argparse
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FONT = "/usr/share/fonts/noto-cjk/NotoSansCJK-Black.ttc"


def glyph_path(font_path, char, box):
    """SVG path data for `char`, scaled and flipped to fit box=(x, y, w, h)."""
    font = next(f for f in TTCollection(font_path).fonts
                if "JP" in f["name"].getDebugName(1) and "Mono" not in f["name"].getDebugName(1))
    gs = font.getGlyphSet()
    glyph = gs[font.getBestCmap()[ord(char)]]
    bounds = BoundsPen(gs)
    glyph.draw(bounds)
    x0, y0, x1, y1 = bounds.bounds
    bx, by, bw, bh = box
    s = min(bw / (x1 - x0), bh / (y1 - y0))
    # Centre in the box; font units are y-up, SVG is y-down.
    dx = bx + (bw - (x1 - x0) * s) / 2 - x0 * s
    dy = by + (bh - (y1 - y0) * s) / 2 + y1 * s
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    glyph.draw(TransformPen(pen, (s, 0, 0, -s, dx, dy)))
    return pen.getCommands()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", default=DEFAULT_FONT)
    a_path = glyph_path(ap.parse_args().font, "あ", (50, 46, 70, 70))
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="wkv-bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6d28d9"/>
      <stop offset="1" stop-color="#db2777"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#wkv-bg)"/>
  <g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round">
    <path d="M18 52a28 28 0 0 0 56 0"/>
    <path d="M46 80v14M32 98h28"/>
  </g>
  <rect x="30" y="14" width="32" height="54" rx="16" fill="#fff"/>
  <path d="{a_path}" fill="#fde68a" stroke="url(#wkv-bg)" stroke-width="9" stroke-linejoin="round" paint-order="stroke"/>
</svg>
"""
    (ROOT / "icons/icon.svg").write_text(svg)
    print(f"wrote icons/icon.svg ({len(svg)} bytes)")


if __name__ == "__main__":
    main()
