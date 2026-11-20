"""Builds the NomadQA icons from assets/nomad-logo.jpg (needs Pillow): run `python3 scripts/make-icons.py`.

The same Nomad triangles as NomadSF, on NomadQA's violet, with a small green check: the QA sister of the NomadSF icon.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TOP = (110, 76, 236)  # violet, lighter at the top
BOTTOM = (64, 36, 170)
EDGE = (150, 128, 255)
CHECK = (34, 197, 94)


def cropped_mark() -> Image.Image:
    img = Image.open(ROOT / 'assets/nomad-logo.jpg').convert('L')
    box = img.point(lambda v: 255 if v > 110 else 0).getbbox()
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    side = max(box[2] - box[0], box[3] - box[1]) * 1.04
    return img.crop((int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2)))


def icon(mark: Image.Image, size: int, fill: float, stroke: float) -> Image.Image:
    scale = 8
    big = size * scale
    radius = int(big * 0.22)
    edge = max(scale, int(big * 0.012))
    # Violet gradient inside a rounded square with a light edge
    grad = Image.new('RGBA', (big, big))
    gd = ImageDraw.Draw(grad)
    for y in range(big):
        t = y / (big - 1)
        gd.line([(0, y), (big, y)], fill=tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((edge, edge, big - 1 - edge, big - 1 - edge), radius=radius - edge, fill=255)
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=EDGE + (255,))
    canvas.paste(grad, (0, 0), mask)
    inner = int(big * fill)
    lines = mark.resize((inner, inner), Image.LANCZOS).point(lambda v: 255 if v > 100 else 0)
    if stroke:
        lines = lines.filter(ImageFilter.MaxFilter(max(3, int(stroke * scale) | 1)))
    offset = (big - inner) // 2
    canvas.paste(Image.new('RGBA', (inner, inner), (255, 255, 255, 255)), (offset - int(big * 0.03), offset), lines)
    # The green check badge, bottom right
    d = ImageDraw.Draw(canvas)
    r = int(big * 0.17)
    cx, cy = big - r - int(big * 0.06), big - r - int(big * 0.06)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=CHECK + (255,), outline=(255, 255, 255, 255), width=max(scale, int(big * 0.025)))
    w = max(scale, int(big * 0.045))
    d.line([(cx - r * 0.45, cy + r * 0.02), (cx - r * 0.1, cy + r * 0.38), (cx + r * 0.5, cy - r * 0.35)], fill=(255, 255, 255, 255), width=w, joint='curve')
    return canvas.resize((size, size), Image.LANCZOS)


SIZES = {16: (0.86, 0.45), 32: (0.82, 0.35), 48: (0.80, 0.25), 128: (0.76, 0.0), 512: (0.74, 0.0)}

if __name__ == '__main__':
    mark = cropped_mark()
    made = {size: icon(mark, size, *spec) for size, spec in SIZES.items()}
    for size in (16, 32, 48, 128):
        made[size].save(ROOT / 'extension/icons' / f'{size}.png', optimize=True)
    made[512].save(ROOT / 'assets/nomadqa-icon-512.png', optimize=True)
    print('icons written')
