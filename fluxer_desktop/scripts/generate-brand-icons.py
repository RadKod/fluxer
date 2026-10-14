# SPDX-License-Identifier: AGPL-3.0-or-later
"""Regenerate desktop icons from the approved Micup PNG (3300ee411).

Run with Python + Pillow 12.2.0: python fluxer_desktop/scripts/generate-brand-icons.py
Stable and canary intentionally share artwork; their names and app IDs differ.
The .icon SVG embeds the PNG because no genuine Micup vector source is available.
Only the ICNS is packaged on macOS; unused Fluxer Assets.car files are removed.
"""

import base64
import hashlib
import io
import json
import shutil
import struct
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1] / "build_resources"
SOURCE = ROOT / "icons-stable/1024x1024.png"
SOURCE_SHA256 = "564de2999d48c5c635be5efc5b7ee53c774a2f97f0d06b96a8536298b9352869"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICNS_SIZES = {
    "icp4": 16, "icp5": 32, "icp6": 64, "ic07": 128, "ic08": 256,
    "ic09": 512, "ic10": 1024, "ic11": 32, "ic12": 64, "ic13": 256, "ic14": 512,
}


def main():
    source = SOURCE.read_bytes()
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("The approved Micup source changed; review it before regenerating icons")
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
    mask = image.convert("L").point(lambda value: max(0, min(255, (value - 32) * 255 // 223)))
    mask = ImageChops.multiply(mask, image.getchannel("A"))
    mark = mask.crop(mask.getbbox())
    for channel in ("stable", "canary"):
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
        metadata["fill"] = {"solid": "display-p3:0.03922,0.03922,0.03922,1.00000"}
        for group in metadata["groups"]:
            group["shadow"]["opacity"] = 0
            group["translucency"]["enabled"] = False
        metadata_json = json.dumps(metadata, indent="\t").replace(
            '"circles": [\n\t\t\t"watchOS"\n\t\t]', '"circles": ["watchOS"]'
        )
        metadata_path.write_text(metadata_json + "\n", encoding="utf-8", newline="\n")
        for size, name in ((16, "FluxerTrayTemplate.png"), (32, "FluxerTrayTemplate@2x.png")):
            width = size - 2
            height = round(mark.height * width / mark.width)
            alpha = Image.new("L", (size, size))
            alpha.paste(mark.resize((width, height), Image.Resampling.LANCZOS), (1, (size - height) // 2))
            template = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            template.putalpha(alpha)
            template.save(icon_root / name, compress_level=9)
    # Existing Windows logos were already generated from this source in stable.
    # Match canary without touching stable's published Windows icon artwork.
    for name in ("icon.ico", "StoreLogo.png", *[path.name for path in (ROOT / "icons-stable").glob("Square*Logo.png")]):
        shutil.copyfile(ROOT / "icons-stable" / name, ROOT / "icons-canary" / name)
    print(f"Micup source sha256={SOURCE_SHA256}; ICNS={len(icns)} bytes; chunks={','.join(ICNS_SIZES)}")


if __name__ == "__main__":
    main()
