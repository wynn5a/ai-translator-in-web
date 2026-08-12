#!/usr/bin/env python3
"""Regenerate icons/ from the 1024px master.

The master is a repaired export: the generator's background removal had punched
alpha holes through the bubble, part of 文 and the sparkle (their RGB survived),
so interior holes were flood-filled back to opaque before squaring the tile.

Usage: python3 tools/make-icons.py
Requires: Pillow
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageMath

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
MASTER = ICONS / "icon-master-1024.png"

# size -> (crop box into the master or None for the whole tile, tile fill fraction)
# Every size keeps the whole squircle: cropping in to enlarge 文 gains a little
# legibility but yields a hard-edged rectangle, and the rounded-square
# silhouette is the stronger recognition cue in a toolbar.
TARGETS = {16: (None, 1.0), 32: (None, 1.0), 48: (None, 0.96), 128: (None, 0.92)}


def unpremul(ch, al):
    return ImageMath.lambda_eval(
        lambda k: k["convert"](
            k["min"](k["float"](k["c"]) * 255.0 / k["max"](k["float"](k["a"]), 1.0), 255.0), "L"),
        c=ch, a=al)


def fit(src, size, frac):
    """Downsample with premultiplied alpha, centred on a transparent tile."""
    w, h = src.size
    sc = min(size * frac / w, size * frac / h)
    tw, th = max(1, round(w * sc)), max(1, round(h * sc))
    r, g, b, a = src.split()
    pre = Image.merge("RGBA", (ImageChops.multiply(r, a),
                               ImageChops.multiply(g, a),
                               ImageChops.multiply(b, a), a))
    r, g, b, a = pre.resize((tw, th), Image.LANCZOS).split()
    art = Image.merge("RGBA", (unpremul(r, a), unpremul(g, a), unpremul(b, a), a))
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(art, ((size - tw) // 2, (size - th) // 2))
    return tile


def main():
    master = Image.open(MASTER).convert("RGBA")
    for size, (box, frac) in TARGETS.items():
        src = master.crop(box) if box else master
        fit(src, size, frac).save(ICONS / f"{size}.png", optimize=True)
        print(f"{size:>4}.png  {'glyph' if box else 'full'} crop, {frac:.0%} fill")


if __name__ == "__main__":
    main()
