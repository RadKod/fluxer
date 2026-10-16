# SPDX-License-Identifier: AGPL-3.0-or-later
"""Regenerate desktop icons from the sanalyer brand symbol (RadKod/sanalyer.com branding/kit/png/simge-1024.png).

Run with Python + Pillow 12.2.0: python fluxer_desktop/scripts/generate-brand-icons.py
Stable, canary and development intentionally share artwork; their names and app IDs differ.
Besides the app icon this writes every icon the main process loads at runtime:
- macOS menu bar: FluxerTrayTemplate.png / @2x (black + alpha template of the mark)
- Windows and Linux tray: tray-glyph.png (+ @1.25x, @1.5x, @2x) and tray-glyph-256x256.png, the white mark on
  transparent; DesktopTray repaints it white or black for the taskbar theme and adds the unread dot at runtime
- Windows taskbar overlay: badges/badge-N.ico and badges/badge-dark-N.ico (N = 1..9, 10 = "9+", 11 = dot)
The .icon SVG embeds the PNG; the vector source is branding/kit/simge.svg in the sanalyer.com repo.
Only the ICNS is packaged on macOS; unused Fluxer Assets.car files are removed.
"""

import base64
import hashlib
import io
import json
import shutil
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "build_resources"
SOURCE = ROOT / "icons-stable/1024x1024.png"
SOURCE_SHA256 = "f80d9174a68dcdf418bb9f782c9f153da3eee3a2bd89597a13f3d282c19a51aa"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
CHANNELS = ("stable", "canary", "development")
TRAY_GLYPHS = {
    "tray-glyph.png": 16, "tray-glyph@1.25x.png": 20, "tray-glyph@1.5x.png": 24, "tray-glyph@2x.png": 32,
    "tray-glyph-256x256.png": 256,
}
BADGE_FONT = Path(__file__).resolve().parents[2] / "packages/fonts/files/FluxerSans/FluxerSans-SemiBold.woff2"
BADGE_FRAME_SIZES = (16, 20, 24, 32, 40, 48)
BADGE_SUPERSAMPLE = 8
BADGE_COUNT = 11
BADGE_VARIANTS = (("badge", (0xB5, 0x17, 0x9E)), ("badge-dark", (0x26, 0x25, 0x2D)))
ICNS_SIZES = {
    "icp4": 16, "icp5": 32, "icp6": 64, "ic07": 128, "ic08": 256,
    "ic09": 512, "ic10": 1024, "ic11": 32, "ic12": 64, "ic13": 256, "ic14": 512,
}


def fit_mark(mark, size, margin):
    """The mark centred vertically, `margin` px from the left and right edges, as an L alpha mask."""
    width = size - 2 * margin
    height = round(mark.height * width / mark.width)
    alpha = Image.new("L", (size, size))
    alpha.paste(mark.resize((width, height), Image.Resampling.LANCZOS), (margin, (size - height) // 2))
    return alpha


def solid(color, alpha):
    image = Image.new("RGBA", alpha.size, (*color, 0))
    image.putalpha(alpha)
    return image


def badge_label(index):
    if index == BADGE_COUNT:
        return None
    return "9+" if index == BADGE_COUNT - 1 else str(index)


def ink_mask(font, label):
    left, top, right, bottom = font.getbbox(label)
    mask = Image.new("L", (right - left + 4, bottom - top + 4))
    ImageDraw.Draw(mask).text((2 - left, 2 - top), label, font=font, fill=255)
    return mask.crop(mask.getbbox())


def render_badge(size, fill, label):
    """Same geometry as upstream's generate-windows-badges.mjs: 87.5% disc, '8' at 49% height, 70% max width."""
    big = size * BADGE_SUPERSAMPLE
    disc = Image.new("L", (big, big))
    inset = big * (1 - 0.875) / 2
    ImageDraw.Draw(disc).ellipse((inset, inset, big - inset, big - inset), fill=255)
    glyph = Image.new("L", (big, big))
    if label is None:
        inset = big * (1 - 0.375) / 2
        ImageDraw.Draw(glyph).ellipse((inset, inset, big - inset, big - inset), fill=255)
    else:
        reference = ink_mask(ImageFont.truetype(str(BADGE_FONT), 1000), "8").height
        font_size = 1000 * big * 0.49 / reference
        ink = ink_mask(ImageFont.truetype(str(BADGE_FONT), round(font_size)), label)
        if ink.width > big * 0.7:
            ink = ink_mask(ImageFont.truetype(str(BADGE_FONT), round(font_size * big * 0.7 / ink.width)), label)
        glyph.paste(ink, ((big - ink.width) // 2, (big - ink.height) // 2))
    image = solid(fill, disc)
    image.paste((255, 255, 255, 255), mask=glyph)
    return image.convert("RGBa").reduce(BADGE_SUPERSAMPLE).convert("RGBA")


def png_bytes(image):
    output = io.BytesIO()
    image.save(output, format="PNG", compress_level=9)
    return output.getvalue()


def encode_ico(frames):
    """PNG-compressed ICO frames, smallest first, like upstream's badge encoder."""
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = len(header) + 16 * len(frames)
    entries = b""
    for size, data in frames:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return header + entries + b"".join(data for _, data in frames)


def main():
    source = SOURCE.read_bytes()
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("The sanalyer source changed; review it before regenerating icons")
    image = Image.open(io.BytesIO(source)).convert("RGBA")
    pngs = {1024: source}
    for size in SIZES[:-1]:
        output = io.BytesIO()
        image.resize((size, size), Image.Resampling.LANCZOS).save(output, format="PNG", compress_level=9)
        pngs[size] = output.getvalue()
    chunks = b"".join(
        kind.encode("ascii") + struct.pack(">I", 8 + len(pngs[size])) + pngs[size]
        for kind, size in ICNS_SIZES.items()
    )
    icns = b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n'
        f'  <image width="1024" height="1024" href="data:image/png;base64,{base64.b64encode(source).decode()}"/>\n'
        '</svg>\n'
    )
    # Extract the white mark from the dark source into Apple's black/alpha template format.
    # Threshold removes the source's faint texture without tracing or inventing a logo.
    # The tile is brand purple (luminance ~86); the squares are white and yellow (>=160).
    mask = image.convert("L").point(lambda value: 255 if value >= 160 else 0)
    mask = ImageChops.multiply(mask, image.getchannel("A"))
    mark = mask.crop(mask.getbbox())
    badges = {
        f"{prefix}-{index}.ico": encode_ico(
            [(size, png_bytes(render_badge(size, fill, badge_label(index)))) for size in BADGE_FRAME_SIZES]
        )
        for prefix, fill in BADGE_VARIANTS
        for index in range(1, BADGE_COUNT + 1)
    }
    for channel in CHANNELS:
        icon_root = ROOT / f"icons-{channel}"
        for size, png in pngs.items():
            (icon_root / f"{size}x{size}.png").write_bytes(png)
        (icon_root / "128x128@2x.png").write_bytes(pngs[256])
        (icon_root / "icon.png").write_bytes(pngs[512])
        (icon_root / "_compiled/AppIcon.icns").write_bytes(icns)
        (icon_root / "_compiled/Assets.car").unlink(missing_ok=True)
        (icon_root / "AppIcon.icon/Assets/Vector.svg").write_text(svg, encoding="utf-8", newline="\n")
        metadata_path = icon_root / "AppIcon.icon/icon.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["fill"] = {"solid": "display-p3:0.70980,0.09020,0.61961,1.00000"}
        for group in metadata["groups"]:
            group["shadow"]["opacity"] = 0
            group["translucency"]["enabled"] = False
            for layer in group["layers"]:
                layer.pop("fill", None)
        metadata_json = json.dumps(metadata, indent="\t").replace(
            '"circles": [\n\t\t\t"watchOS"\n\t\t]', '"circles": ["watchOS"]'
        )
        metadata_path.write_text(metadata_json + "\n", encoding="utf-8", newline="\n")
        for size, name in ((16, "FluxerTrayTemplate.png"), (32, "FluxerTrayTemplate@2x.png")):
            solid((0, 0, 0), fit_mark(mark, size, 1)).save(icon_root / name, compress_level=9)
        for name, size in TRAY_GLYPHS.items():
            solid((255, 255, 255), fit_mark(mark, size, round(size / 16))).save(icon_root / name, compress_level=9)
        (icon_root / "badges").mkdir(exist_ok=True)
        for name, data in badges.items():
            (icon_root / "badges" / name).write_bytes(data)
    # Windows: the .ico and the Store tiles come from the same source.
    stable_root = ROOT / "icons-stable"
    image.save(stable_root / "icon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    for logo in list(stable_root.glob("Square*Logo.png")) + [stable_root / "StoreLogo.png"]:
        with Image.open(logo) as existing:
            size = existing.size
        image.resize(size, Image.Resampling.LANCZOS).save(logo, format="PNG", compress_level=9)
    for name in ("icon.ico", "StoreLogo.png", *[path.name for path in stable_root.glob("Square*Logo.png")]):
        shutil.copyfile(stable_root / name, ROOT / "icons-canary" / name)
    shutil.copyfile(stable_root / "icon.ico", ROOT / "icons-development" / "icon.ico")
    print(f"sanalyer source sha256={SOURCE_SHA256}; ICNS={len(icns)} bytes; chunks={','.join(ICNS_SIZES)}; badges={len(badges)}")


if __name__ == "__main__":
    main()
