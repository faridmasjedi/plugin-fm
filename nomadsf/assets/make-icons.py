"""Builds the NomadSF icons from assets/nomad-logo.jpg (needs Pillow): run `python3 assets/make-icons.py`.

The white triangles are cropped and placed on a dark rounded square with a thin light edge (so
the icon shows on dark toolbars too); small sizes get slightly thicker lines so they stay visible.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BACKGROUND = (16, 17, 22)
EDGE = (70, 72, 84)


def cropped_mark() -> Image.Image:
    img = Image.open(HERE / 'nomad-logo.jpg').convert('L')
    box = img.point(lambda v: 255 if v > 110 else 0).getbbox()
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    side = max(box[2] - box[0], box[3] - box[1]) * 1.04
    return img.crop((int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2)))


def icon(mark: Image.Image, size: int, fill: float, stroke: float) -> Image.Image:
    scale = 8
    big = size * scale
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    edge = max(scale, int(big * 0.012))
    radius = int(big * 0.22)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=EDGE + (255,))
    draw.rounded_rectangle((edge, edge, big - 1 - edge, big - 1 - edge), radius=radius - edge, fill=BACKGROUND + (255,))
    inner = int(big * fill)
    lines = mark.resize((inner, inner), Image.LANCZOS).point(lambda v: 255 if v > 100 else 0)
    if stroke:
        lines = lines.filter(ImageFilter.MaxFilter(max(3, int(stroke * scale) | 1)))
    offset = (big - inner) // 2
    canvas.paste(Image.new('RGBA', (inner, inner), (255, 255, 255, 255)), (offset, offset + int(big * 0.02)), lines)
    return canvas.resize((size, size), Image.LANCZOS)


# size: (how much of the square the mark fills, extra line width in pixels)
SIZES = {16: (0.86, 0.45), 32: (0.82, 0.35), 48: (0.80, 0.25), 128: (0.76, 0.0), 512: (0.74, 0.0)}

if __name__ == '__main__':
    mark = cropped_mark()
    made = {size: icon(mark, size, *spec) for size, spec in SIZES.items()}
    for size in (16, 32, 48, 128):
        made[size].save(ROOT / 'apps/extension/public/icons' / f'{size}.png', optimize=True)
    made[128].save(ROOT / 'packages/ui/public/logo.png', optimize=True)
    made[32].save(ROOT / 'packages/ui/public/favicon.png', optimize=True)
    made[512].save(HERE / 'nomad-icon-512.png', optimize=True)
    print('icons written')
