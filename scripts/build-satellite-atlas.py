#!/usr/bin/env python3
"""Rebuild the checked-in Sentinel-2 atlas from its public AWS source thumbnails.

Requires Pillow: python3 -m pip install Pillow
Run from any directory: python3 scripts/build-satellite-atlas.py
The manifest pins acquisitions, source URLs, pixel crops, and layout. Downloads
are small RGB previews, not full satellite scenes. No AWS account is needed.
"""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
from urllib.request import urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "public" / "satellite-sources.json"


def download_tile(source, tile_size):
    with urlopen(source["thumbnailUrl"], timeout=60) as response:
        image = Image.open(BytesIO(response.read())).convert("RGB")
    if list(image.size) != source["thumbnailDimensions"]:
        raise ValueError(f"Unexpected source dimensions for {source['itemId']}")
    crop = image.crop(tuple(source["cropPixels"]))
    return source, crop.resize((tile_size, tile_size), Image.Resampling.LANCZOS)


def main():
    manifest = json.loads(MANIFEST.read_text())
    layout = manifest["layout"]
    size = layout["tileSize"]
    atlas = Image.new("RGB", (layout["width"], layout["height"]))
    with ThreadPoolExecutor(max_workers=4) as workers:
        jobs = [workers.submit(download_tile, source, size) for source in manifest["sources"]]
        for job in jobs:
            source, tile = job.result()
            atlas.paste(tile, (source["column"] * size, source["row"] * size))
    target = ROOT / "public" / "satellite-atlas.jpg"
    atlas.save(target, quality=92, subsampling=0, optimize=True)
    print(f"Built {target.name}: {atlas.width} × {atlas.height}, {len(jobs)} authentic satellite crops")


if __name__ == "__main__":
    main()
