#!/usr/bin/env python3
"""Build a natural-color photomosaic library from thousands of wide satellite scenes.

Requires Pillow. Run with --discover to obtain a new globally distributed set
of pinned Sentinel-2 acquisitions, or without it to rebuild the checked-in set.
Every atlas image is one distinct real acquisition, shown at a wide scale.
Native-size WebP previews and optional 128px-per-scene detail atlas pages retain
the same crop at higher resolution. Use --previews-only to add those assets to
the pinned library without rebuilding its base atlas or color lookup tables.
Use --matching-only to rebuild color candidates and luminance descriptors
entirely from the checked-in base atlas, without downloading or changing photos.
No colors, exposure, contrast, or saturation are modified.
"""
from argparse import ArgumentParser
from bisect import insort
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
import http.client
from io import BytesIO
import json
from math import ceil, sqrt
from pathlib import Path
import random
import tempfile
import threading
import time
from urllib.parse import urlencode, urlparse

from PIL import Image, ImageChops, ImageStat, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
TILE_SIZE, COLUMNS, LUT_SIZE, VARIANTS = 64, 64, 32, 8
PAGE_ROWS, MAX_SCENES = 64, 16384
MATCH_TOLERANCE = 0.0020
LOCAL = threading.local()
API = "https://earth-search.aws.element84.com/v1"
# Geographic strata give each part of the world a chance to enter the library.
# Northern acquisitions use June; southern acquisitions use February.
REGIONS = [
    ("Alaska and northwestern Canada", [-170, 50, -120, 72]),
    ("Western North America", [-130, 20, -100, 50]),
    ("Central North America", [-105, 25, -85, 60]),
    ("Eastern North America", [-90, 25, -52, 60]),
    ("Central America and the Caribbean", [-110, 7, -60, 26]),
    ("Northern South America", [-82, -12, -45, 12]),
    ("Eastern South America", [-65, -30, -34, -8]),
    ("Andes and Patagonia", [-80, -56, -50, -15]),
    ("Western Europe", [-13, 35, 15, 60]),
    ("Scandinavia and the Baltic", [0, 55, 40, 72]),
    ("Eastern Europe", [15, 35, 50, 58]),
    ("Western Sahara and Atlantic Africa", [-18, 5, 10, 35]),
    ("Central Sahara", [0, 15, 30, 34]),
    ("Eastern Africa and the Nile", [25, -12, 52, 32]),
    ("Southern Africa", [10, -36, 43, -10]),
    ("Central Africa", [5, -14, 32, 10]),
    ("Arabian Peninsula", [34, 12, 60, 34]),
    ("Central Asia", [45, 30, 90, 56]),
    ("Himalayas and Indian subcontinent", [65, 5, 95, 38]),
    ("Siberia", [50, 52, 150, 72]),
    ("East Asia", [95, 20, 145, 52]),
    ("Southeast Asia", [92, -11, 142, 23]),
    ("Western Australia", [110, -38, 135, -10]),
    ("Eastern Australia", [130, -43, 155, -10]),
    ("New Zealand and South Pacific", [155, -49, 179.9, -12]),
    ("Greenland and Iceland", [-65, 59, -10, 83]),
    ("Antarctic Peninsula", [-80, -80, -45, -62]),
    ("East Antarctica", [0, -80, 150, -63]),
]


def color_feature(rgb):
    linear = [c / 3294.6 if c <= 10.31475 else ((c / 255 + 0.055) / 1.055) ** 2.4 for c in rgb]
    r, g, b = linear
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return ((0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s) * 1.35,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def request_bytes(url):
    parsed = urlparse(url)
    if not hasattr(LOCAL, "connections"):
        LOCAL.connections = {}
    for attempt in range(3):
        try:
            conn = LOCAL.connections.get(parsed.netloc)
            if conn is None:
                conn = http.client.HTTPSConnection(parsed.netloc, timeout=40)
                LOCAL.connections[parsed.netloc] = conn
            path = parsed.path + ("?" + parsed.query if parsed.query else "")
            conn.request("GET", path, headers={"User-Agent": "MusicMaps-Sentinel-library/1.0"})
            response = conn.getresponse()
            payload = response.read()
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}: {url}")
            return payload
        except Exception:
            old = LOCAL.connections.pop(parsed.netloc, None)
            if old:
                old.close()
            if attempt == 2:
                raise
            time.sleep(0.4 * (attempt + 1))


def search_region(region, cache):
    name, bounds = region
    month = "02" if bounds[1] < -5 else "06"
    query = {
        "collections": "sentinel-2-l2a", "bbox": ",".join(map(str, bounds)),
        "datetime": f"2024-{month}-01T00:00:00Z/2024-{month}-20T23:59:59Z", "limit": 500,
        "query": json.dumps({"eo:cloud_cover": {"lt": 8}, "s2:nodata_pixel_percentage": {"lt": 1}}),
        "fields": "properties.eo:cloud_cover,properties.grid:code,properties.s2:nodata_pixel_percentage,"
                  "properties.s2:water_percentage,properties.s2:snow_ice_percentage,"
                  "properties.earthsearch:s3_path,-assets,-geometry,-links,-stac_extensions,-stac_version",
    }
    path = cache / (sha256(json.dumps(query, sort_keys=True).encode()).hexdigest()[:16] + ".json")
    if not path.exists():
        payload = request_bytes(API + "/search?" + urlencode(query))
        parsed = json.loads(payload)
        if "features" not in parsed:
            raise ValueError("Invalid STAC search response")
        path.write_bytes(payload)
    features = json.loads(path.read_text())["features"]
    by_grid = {}
    for item in features:
        props = item["properties"]
        grid = props.get("grid:code")
        bounds = item.get("bbox", [])
        if (not grid or not props.get("earthsearch:s3_path") or len(bounds) != 4
                or not 0 < bounds[2] - bounds[0] <= 30):
            continue
        if grid not in by_grid or props["eo:cloud_cover"] < by_grid[grid]["properties"]["eo:cloud_cover"]:
            by_grid[grid] = item
    chosen = list(by_grid.values())
    random.Random(name).shuffle(chosen)
    # Rotate water, snow, and ordinary terrain so coastal/bright scenes are
    # represented even in a limited regional quota.
    buckets = [[], [], []]
    for item in chosen:
        props = item["properties"]
        bucket = 0 if props.get("s2:water_percentage", 0) >= 10 else 1 if props.get("s2:snow_ice_percentage", 0) >= 15 else 2
        buckets[bucket].append(item)
    result = []
    while any(buckets):
        for bucket in buckets:
            if bucket:
                result.append(bucket.pop())
    print(f"Catalog: {name}: {len(result)} distinct geographic scenes", flush=True)
    return name, result


def modes_for(source, original_index=None):
    if original_index is not None:
        modes = []
        if original_index in [1, 2, 3, 9, 11]:
            modes.append("coasts")
        if original_index in [0, 4, 5, 6, 7, 12, 13, 14, 15]:
            modes.append("terrain")
        return modes + ["satellite"]
    water = source.get("waterCoverPercent", 0)
    modes = []
    if water >= 5:
        modes.append("coasts")
    if water < 75:
        modes.append("terrain")
    return modes + ["satellite"]


def source_from_item(item, region):
    props = item["properties"]
    s3_path = props["earthsearch:s3_path"]
    root = s3_path.replace("s3://sentinel-cogs/", "https://sentinel-cogs.s3.us-west-2.amazonaws.com/")
    grid = props["grid:code"].replace("MGRS-", "")
    source = {
        "region": f"{region} · {grid}", "collection": "sentinel-2-l2a",
        "itemId": item["id"], "acquiredAt": props["datetime"],
        "cloudCoverPercent": props["eo:cloud_cover"], "sceneBoundingBox": item["bbox"],
        "thumbnailUrl": root + "/thumbnail.jpg",
        "stacItemUrl": f"{API}/collections/sentinel-2-l2a/items/{item['id']}",
        "gridCode": props["grid:code"], "geographicRegion": region,
        "nodataPercent": props.get("s2:nodata_pixel_percentage", 0),
        "waterCoverPercent": props.get("s2:water_percentage", 0),
        "snowIceCoverPercent": props.get("s2:snow_ice_percentage", 0),
    }
    source["imageryModes"] = modes_for(source)
    return source


def wide_crop(image):
    # Search broad squares, never tiny patches. No-data is black in RGB
    # thumbnails. A small black-pixel allowance avoids rejecting real shadows.
    width, height = image.size
    short = min(width, height)
    for fraction in [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7]:
        side = ceil(short * fraction)
        best = None
        for iy in range(5):
            top = round((height - side) * iy / 4)
            for ix in range(5):
                left = round((width - side) * ix / 4)
                box = (left, top, left + side, top + side)
                probe = image.crop(box).resize((64, 64), Image.Resampling.NEAREST)
                red, green, blue = probe.split()
                maximum = ImageChops.lighter(ImageChops.lighter(red, green), blue)
                black = sum(maximum.histogram()[:5]) / (probe.width * probe.height)
                if best is None or black < best[0]:
                    best = black, box
                if black == 0:
                    return box, black
        if best[0] < 0.002:
            return best[1], best[0]
    raise ValueError("No broad scene crop without nodata")


def download_source(source, cache):
    path = cache / f"{source['itemId']}.jpg"
    if not path.exists():
        try:
            payload = request_bytes(source["thumbnailUrl"])
        except Exception:
            # Some older Sentinel COGs expose the same preview under this
            # STAC asset filename. Record the actual successful URL.
            alternative = source["thumbnailUrl"].replace("/thumbnail.jpg", "/preview.jpg")
            if alternative == source["thumbnailUrl"]:
                raise
            payload = request_bytes(alternative)
            source["thumbnailUrl"] = alternative
        Image.open(BytesIO(payload)).verify()
        path.write_bytes(payload)
    payload = path.read_bytes()
    image = Image.open(BytesIO(payload)).convert("RGB")
    if min(image.size) < 64:
        raise ValueError("Source thumbnail unexpectedly small")
    crop, black_fraction = wide_crop(image)
    source["thumbnailDimensions"] = list(image.size)
    source["cropPixels"] = list(crop)
    source["thumbnailSha256"] = sha256(payload).hexdigest()
    source["cropFraction"] = round((crop[2] - crop[0]) / min(image.size), 6)
    source["cropNodataFraction"] = black_fraction
    return source, image.crop(crop).resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)


def lookup_tables(patches, sources, output):
    def tree(points, depth=0):
        if not points:
            return None
        axis = depth % 3
        points.sort(key=lambda point: (point[0][axis], point[1]))
        m = len(points) // 2
        return points[m], axis, tree(points[:m], depth + 1), tree(points[m + 1:], depth + 1)

    def nearest(node, target, best):
        if node is None:
            return
        (feature, patch_id), axis, left, right = node
        distance = sum((a - b) ** 2 for a, b in zip(feature, target))
        if len(best) < VARIANTS or (distance, patch_id) < best[-1]:
            insort(best, (distance, patch_id))
            if len(best) > VARIANTS:
                best.pop()
        delta = target[axis] - feature[axis]
        first, second = (left, right) if delta < 0 else (right, left)
        nearest(first, target, best)
        if len(best) < VARIANTS or delta * delta <= best[-1][0]:
            nearest(second, target, best)

    targets = [color_feature([r * 255 / 31, g * 255 / 31, b * 255 / 31])
               for g in range(LUT_SIZE) for b in range(LUT_SIZE) for r in range(LUT_SIZE)]
    urls, counts = {}, {}
    by_id = {source["index"]: source for source in sources}
    for mode in ["coasts", "terrain", "satellite"]:
        pool = [patch for patch in patches if mode in by_id[patch["sourceIndex"]]["imageryModes"]]
        search_tree = tree([(color_feature(patch["meanRgb"]), patch["index"]) for patch in pool])
        pixels = [bytearray() for _ in range(VARIANTS)]
        chosen = set()
        for target in targets:
            candidates = []
            nearest(search_tree, target, candidates)
            for variant in range(VARIANTS):
                candidate = candidates[min(variant, len(candidates) - 1)]
                if candidate[0] > candidates[0][0] + MATCH_TOLERANCE:
                    candidate = candidates[0]
                patch_id = candidate[1]
                pixels[variant].extend((patch_id % 256, patch_id // 256, 0, 255))
                chosen.add(patch_id)
        filename = f"satellite-mosaic-{mode}-lut.png"
        Image.frombytes("RGBA", (LUT_SIZE * LUT_SIZE, LUT_SIZE * VARIANTS), b"".join(pixels)).save(output / filename, optimize=True)
        urls[mode] = "/" + filename
        counts[mode] = len(pool)
        print(f"Lookup {mode}: {len(pool)} real scenes, {len(chosen)} chosen across {VARIANTS} close matches", flush=True)
    return {"size": LUT_SIZE, "variants": VARIANTS, "urls": urls, "modeCounts": counts,
            "encoding": "RGBA8: patchIndex = red + green * 256; blue = 0; alpha = 255",
            "coordinates": "x = redBin + blueBin * size; y = variant * size + greenBin",
            "matching": f"Nearest mean color in weighted OKLab (lightness 1.35). Up to {VARIANTS} distinct close matches, squared distance no more than best+{MATCH_TOLERANCE:.4f}. No pixel recoloring."}


def page_layouts(count, size, basename):
    """Partition a logical row-major atlas into GPU-sized image pages."""
    pages = []
    for page_index, start in enumerate(range(0, count, COLUMNS * PAGE_ROWS)):
        rows = ceil(min(COLUMNS * PAGE_ROWS, count - start) / COLUMNS)
        suffix = f"-{page_index}" if page_index else ""
        pages.append({"url": f"/{basename}{suffix}.jpg", "columns": COLUMNS,
                      "rows": rows, "tileSize": size, "width": COLUMNS * size, "height": rows * size})
    return pages


def feature_texture(patches, layout, atlas_path, output, atlas_pages=None):
    """Encode photo statistics for GPU matching; do not alter any image pixels."""
    columns, rows, size = layout["columns"], layout["rows"], layout["tileSize"]
    pages = atlas_pages or [{**layout, "url": "/" + atlas_path.name}]
    features = Image.new("RGBA", (columns * 2, rows))
    pixels = features.load()
    half = size // 2
    quadrants = [(0, 0, half, half), (half, 0, size, half),
                 (0, half, half, size), (half, half, size, size)]
    row_offset = 0
    for page in pages:
        with Image.open(atlas_path.parent / page["url"].lstrip("/")) as image:
            atlas = image.convert("RGB")
        if (page["columns"] != columns or page["tileSize"] != size
                or atlas.size != (columns * size, page["rows"] * size)):
            raise ValueError("Base atlas page dimensions do not match its layout")
        for patch in patches:
            if not row_offset <= patch["row"] < row_offset + page["rows"]:
                continue
            x, y = patch["column"] * size, (patch["row"] - row_offset) * size
            tile = atlas.crop((x, y, x + size, y + size))
            mean_rgb = ImageStat.Stat(tile).mean
            lumas = [r * 0.2126 + g * 0.7152 + b * 0.0722 for r, g, b in tile.get_flattened_data()]
            mean_luma = sum(lumas) / len(lumas)
            deviation = sqrt(max(0, sum(value * value for value in lumas) / len(lumas) - mean_luma * mean_luma))
            contrast = min(255, round(deviation * 2))
            quadrant_lumas = []
            for bounds in quadrants:
                r, g, b = ImageStat.Stat(tile.crop(bounds)).mean
                quadrant_lumas.append(round(r * 0.2126 + g * 0.7152 + b * 0.0722))
            pixels[patch["column"] * 2, patch["row"]] = tuple(round(c) for c in mean_rgb) + (contrast,)
            pixels[patch["column"] * 2 + 1, patch["row"]] = tuple(quadrant_lumas)
        atlas.close()
        row_offset += page["rows"]
    if row_offset != rows:
        raise ValueError("Base atlas pages do not cover the logical atlas rows")
    filename = "satellite-features.png"
    features.save(output / filename, optimize=True)
    print(f"Feature texture: {features.width}×{features.height}, {len(patches)} natural image descriptors", flush=True)
    return {"url": "/" + filename, "columns": columns, "rows": rows, "texelsPerPatch": 2,
            "encoding": "RGBA8, unflipped top-first rows. First texel: mean R,G,B and twice luminance standard deviation. Second texel: mean luminance TL,TR,BL,BR. All channels 0..255; luminance uses Rec.709 weights 0.2126,0.7152,0.0722."}


def native_crop(patch, source, cache):
    """Read the exact atlas crop at source resolution, without resampling."""
    path = cache / f"{source['itemId']}.jpg"
    if not path.exists():
        payload = request_bytes(source["thumbnailUrl"])
        Image.open(BytesIO(payload)).verify()
        path.write_bytes(payload)
    payload = path.read_bytes()
    if source.get("thumbnailSha256") and sha256(payload).hexdigest() != source["thumbnailSha256"]:
        raise ValueError(f"Source content changed for {source['itemId']}")
    image = Image.open(BytesIO(payload)).convert("RGB")
    if list(image.size) != source["thumbnailDimensions"]:
        raise ValueError(f"Source dimensions changed for {source['itemId']}")
    left, top, right, bottom = patch["cropPixels"]
    if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
        raise ValueError(f"Invalid native crop for {source['itemId']}")
    return image.crop((left, top, right, bottom))


def add_high_detail_assets(manifest, sources, cache, output, workers):
    """Generate lazy-load assets; keep base atlas pixels and matching unchanged."""
    patches = manifest["patches"]
    by_id = {source["index"]: source for source in sources}
    if len({patch["sourceIndex"] for patch in patches}) != len(patches):
        raise ValueError("Native preview filenames require one crop per source scene")
    preview_output = output / "satellite-scenes"
    preview_output.mkdir(exist_ok=True)
    detail_size = 128
    detail_pages = page_layouts(len(patches), detail_size, "satellite-mosaic-detail")

    def make_preview(patch):
        crop = native_crop(patch, by_id[patch["sourceIndex"]], cache)
        filename = f"{patch['sourceIndex']}.webp"
        path = preview_output / filename
        # Retain native dimensions. WebP is only transport compression; no
        # enlargement, color adjustment, sharpening, or pixel synthesis.
        crop.save(path, format="WEBP", quality=90, method=4)
        tile = crop.resize((detail_size, detail_size), Image.Resampling.LANCZOS)
        return patch, filename, crop.size, path.stat().st_size, tile

    count, total_bytes = 0, 0
    with ThreadPoolExecutor(max_workers=min(workers, 8)) as pool:
        row_offset = 0
        for page in detail_pages:
            detail = Image.new("RGB", (page["width"], page["height"]))
            page_patches = [patch for patch in patches if row_offset <= patch["row"] < row_offset + page["rows"]]
            jobs = [pool.submit(make_preview, patch) for patch in page_patches]
            for job in as_completed(jobs):
                patch, filename, dimensions, byte_count, tile = job.result()
                patch["previewUrl"] = f"/satellite-scenes/{filename}"
                patch["previewWidth"], patch["previewHeight"] = dimensions
                detail.paste(tile, (patch["column"] * detail_size, (patch["row"] - row_offset) * detail_size))
                tile.close()
                total_bytes += byte_count
                count += 1
                if count % 512 == 0:
                    print(f"Native previews: {count}/{len(patches)} scenes, {total_bytes / 1e6:.1f} MB", flush=True)
            detail_path = output / page["url"].lstrip("/")
            detail.save(detail_path, quality=92, subsampling=0, optimize=True)
            detail.close()
            row_offset += page["rows"]
            print(f"Detail page: {detail_path.name}, {page['width']}×{page['height']}, {detail_path.stat().st_size:,} bytes", flush=True)
    manifest["detailPages"] = detail_pages
    manifest["detailAtlas"] = dict(detail_pages[0])
    manifest.setdefault("build", {}).update({
        "nativePreviewCount": count, "nativePreviewFormat": "WebP", "nativePreviewQuality": 90,
        "nativePreviewTotalBytes": total_bytes, "detailAtlasJpegQuality": 92,
    })
    description = " Native previews preserve the same crop at original thumbnail resolution with WebP compression; the optional detail atlas downsamples those original crops to 128px."
    if description not in manifest["processing"]:
        manifest["processing"] += description
    # Make assets available before the manifest advertises their URLs.
    preview_public = PUBLIC / "satellite-scenes"
    preview_public.mkdir(exist_ok=True)
    for patch in patches:
        filename = f"{patch['sourceIndex']}.webp"
        (preview_public / filename).write_bytes((preview_output / filename).read_bytes())
    for page in detail_pages:
        filename = page["url"].lstrip("/")
        (PUBLIC / filename).write_bytes((output / filename).read_bytes())
    print(f"Native previews complete: {count} images, {total_bytes:,} bytes; {len(detail_pages)} detail atlas pages", flush=True)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--previews-only", action="store_true",
                        help="Add native previews and the optional detail atlas without changing base imagery or LUTs")
    parser.add_argument("--matching-only", action="store_true",
                        help="Rebuild candidate LUTs and GPU descriptors from the local base atlas, without network access")
    parser.add_argument("--sources-file", type=Path,
                        help="Build a prepared source manifest without replacing the live manifest before validation")
    parser.add_argument("--count", type=int, help="Number of scenes; defaults to the pinned library size")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / "musicmaps-satellite-scenes-cache")
    args = parser.parse_args()
    pinned_path = args.sources_file or PUBLIC / "satellite-scenes.json"
    pinned = json.loads(pinned_path.read_text()) if pinned_path.exists() else None
    if args.sources_file and (args.discover or args.matching_only or args.previews_only):
        parser.error("--sources-file cannot be combined with discovery or partial rebuilds")
    if args.count is None:
        args.count = len(pinned["sources"]) if pinned and not args.discover else 4096
    if not 2048 <= args.count <= MAX_SCENES:
        parser.error(f"--count must be between 2048 and {MAX_SCENES}")
    cache = args.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    catalog_cache = cache / "catalog"
    catalog_cache.mkdir(exist_ok=True)
    output = cache / "build"
    output.mkdir(exist_ok=True)
    started = time.monotonic()
    if args.matching_only:
        if args.discover or args.previews_only:
            parser.error("--matching-only cannot be combined with discovery or preview generation")
        manifest_path = PUBLIC / "satellite-mosaic.json"
        manifest = json.loads(manifest_path.read_text())
        sources = json.loads((PUBLIC / manifest["sourceManifest"].lstrip("/")).read_text())["sources"]
        manifest["lookup"] = lookup_tables(manifest["patches"], sources, output)
        manifest["features"] = feature_texture(manifest["patches"], manifest["layout"],
                                                PUBLIC / manifest["atlas"].lstrip("/"), output, manifest.get("atlasPages"))
        for url in [*manifest["lookup"]["urls"].values(), manifest["features"]["url"]]:
            (PUBLIC / url.lstrip("/")).write_bytes((output / url.lstrip("/")).read_bytes())
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        print(f"Matching assets ready in {time.monotonic() - started:.1f}s; source photos and atlas pixels unchanged", flush=True)
        return
    if args.previews_only:
        if args.discover:
            parser.error("--previews-only uses the pinned library; it cannot be combined with --discover")
        manifest_path = PUBLIC / "satellite-mosaic.json"
        manifest = json.loads(manifest_path.read_text())
        sources = json.loads((PUBLIC / manifest["sourceManifest"].lstrip("/")).read_text())["sources"]
        add_high_detail_assets(manifest, sources, cache, output, args.workers)
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        print(f"High-detail assets ready in {time.monotonic() - started:.1f}s; base atlas and LUTs unchanged", flush=True)
        return
    original = json.loads((PUBLIC / "satellite-sources.json").read_text())
    originals = original["sources"]
    for source in originals:
        source["imageryModes"] = modes_for(source, source["index"])
        old_path = Path(tempfile.gettempdir()) / "musicmaps-satellite-mosaic-cache" / f"{source['itemId']}.jpg"
        if old_path.exists() and not (cache / old_path.name).exists():
            (cache / old_path.name).write_bytes(old_path.read_bytes())
    if pinned_path.exists() and not args.discover:
        candidates = pinned["sources"]
        print(f"Rebuilding {len(candidates)} pinned source records", flush=True)
    else:
        regions = []
        with ThreadPoolExecutor(max_workers=4) as workers:
            jobs = {workers.submit(search_region, region, catalog_cache): index for index, region in enumerate(REGIONS)}
            for job in as_completed(jobs):
                try:
                    name, features = job.result()
                    regions.append((jobs[job], name, list(reversed(features))))
                except Exception as error:
                    print(f"Catalog region unavailable: {REGIONS[jobs[job]][0]}: {error}", flush=True)
        regions.sort()
        candidates = [dict(source) for source in originals]
        seen_ids = {source["itemId"] for source in originals}
        seen_grids = {"MGRS-" + source["itemId"].split("_")[1] for source in originals}
        while any(features for _, _, features in regions):
            for _, name, features in regions:
                while features:
                    item = features.pop()
                    grid = item["properties"]["grid:code"]
                    if item["id"] in seen_ids or grid in seen_grids:
                        continue
                    seen_ids.add(item["id"])
                    seen_grids.add(grid)
                    candidates.append(source_from_item(item, name))
                    break
        (cache / "discovered-candidates.json").write_text(json.dumps(candidates, separators=(",", ":")))
        print(f"Discovery complete: {len(candidates)} distinct acquisitions / {len(seen_grids)} geographic grids in {time.monotonic() - started:.1f}s", flush=True)
    if len(candidates) < args.count:
        raise ValueError(f"Only {len(candidates)} distinct candidate scenes found; need {args.count}")

    # Fetch a modest reserve to replace missing thumbnails or invalid wide views.
    successful, failed = {}, []
    next_candidate = 0
    with ThreadPoolExecutor(max_workers=args.workers) as workers:
        while len(successful) < args.count and next_candidate < len(candidates):
            missing = args.count - len(successful)
            batch = candidates[next_candidate:next_candidate + missing + 64]
            jobs = {workers.submit(download_source, dict(source), cache): next_candidate + i for i, source in enumerate(batch)}
            next_candidate += len(batch)
            for job in as_completed(jobs):
                rank = jobs[job]
                try:
                    successful[rank] = job.result()
                except Exception as error:
                    failed.append((rank, str(error)))
                complete = len(successful) + len(failed)
                if complete % 128 == 0:
                    print(f"Downloaded {len(successful)} valid wide scenes, {len(failed)} rejected; elapsed {time.monotonic() - started:.0f}s", flush=True)
    if len(successful) < args.count:
        raise ValueError(f"Only {len(successful)} valid scenes after downloads")
    # Original IDs remain stable even when one original cannot supply a broad,
    # nodata-free crop and stays available only in the curated source gallery.
    sources = [dict(source) for source in originals]
    if pinned_path.exists() and not args.discover:
        sources = [dict(source) for source in candidates]
    patches = []
    selected = [successful[key] for key in sorted(successful)[:args.count]]
    rows = ceil(len(selected) / COLUMNS)
    atlas_pages = page_layouts(len(selected), TILE_SIZE, "satellite-mosaic")
    row_offset = 0
    for page in atlas_pages:
        atlas = Image.new("RGB", (page["width"], page["height"]))
        start = row_offset * COLUMNS
        page_patches = []
        for source, tile in selected[start:start + page["rows"] * COLUMNS]:
            source_index = source.get("index")
            if source_index is None:
                source_index = len(sources)
                source["index"] = source_index
                sources.append(source)
            else:
                sources[source_index] = source
            index = len(patches)
            column, row = index % COLUMNS, index // COLUMNS
            atlas.paste(tile, (column * TILE_SIZE, (row - row_offset) * TILE_SIZE))
            patch = {"index": index, "sourceIndex": source_index, "column": column, "row": row,
                     "meanRgb": [], "cropPixels": source["cropPixels"]}
            patches.append(patch)
            page_patches.append(patch)
        page_path = output / page["url"].lstrip("/")
        atlas.save(page_path, quality=95, subsampling=0, optimize=True)
        atlas.close()
        with Image.open(page_path) as image:
            decoded = image.convert("RGB")
        for patch in page_patches:
            x, y = patch["column"] * TILE_SIZE, (patch["row"] - row_offset) * TILE_SIZE
            patch["meanRgb"] = [round(value, 4) for value in ImageStat.Stat(decoded.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))).mean]
        decoded.close()
        row_offset += page["rows"]
        print(f"Base page: {page_path.name}, {page['width']}×{page['height']}, {page_path.stat().st_size:,} bytes", flush=True)
    atlas_path = output / "satellite-mosaic.jpg"
    lookup = lookup_tables(patches, sources, output)
    attribution = {key: original[key] for key in ["attribution", "hosting", "provider", "registryUrl", "licenseUrl"]}
    scene_manifest = {
        "title": "Globally distributed wide Sentinel-2 scene library", **attribution,
        "processing": "Pinned 2024 Sentinel-2 RGB thumbnails. One wide image per distinct acquisition; new scenes are selected from low-cloud, low-nodata catalog observations. Cropping, resizing, and JPEG encoding only; natural colors remain unchanged.",
        "discovery": {"api": API, "year": 2024, "cloudCoverMaxPercent": 8, "nodataMaxPercent": 1,
                      "geographicRegions": sorted({source["geographicRegion"] for source in sources if source.get("geographicRegion")}), "uniqueGridLocations": len({source.get('gridCode', source['itemId'].split('_')[1]) for source in sources}),
                      "selection": pinned.get("expansion", {}).get("selection", "Round-robin regional coverage; one acquisition per MGRS grid; preserve original 16 curated source IDs") if pinned else "Round-robin regional coverage; one acquisition per MGRS grid"},
        "sources": sources,
    }
    if pinned and not args.discover and "expansion" in pinned:
        scene_manifest["expansion"] = pinned["expansion"]
    (output / "satellite-scenes.json").write_text(json.dumps(scene_manifest, separators=(",", ":")) + "\n")
    lumas = [sum(c * w for c, w in zip(p["meanRgb"], [0.2126, 0.7152, 0.0722])) for p in patches]
    manifest = {
        "title": "Natural-color wide-scene Sentinel-2 photomosaic library", "atlas": "/satellite-mosaic.jpg",
        "atlasPages": atlas_pages,
        "layout": {"columns": COLUMNS, "rows": rows, "tileSize": TILE_SIZE, "width": COLUMNS * TILE_SIZE, "height": rows * TILE_SIZE,
                   "order": "row-major, starting at top-left", "padding": 0},
        "sourceManifest": "/satellite-scenes.json", **attribution,
        "processing": "One wide image per distinct real satellite acquisition. Every crop spans at least 70% of its source thumbnail short side. Images are only cropped, resized with Lanczos, and JPEG encoded; no recoloring, grayscale, contrast changes, or generated imagery. cropPixels records original thumbnail [left, top, right, bottom]; meanRgb measures the delivered JPEG.",
        "build": {"script": "scripts/build-satellite-scenes.py", "pillowVersion": PILLOW_VERSION, "patchesPerSource": 1,
                  "distinctSceneCount": len(patches), "jpegQuality": 95, "jpegSubsampling": 0, "minimumCropFraction": 0.7},
        "lookup": lookup,
        "coverage": {"meanRgbMin": [min(p["meanRgb"][i] for p in patches) for i in range(3)],
                     "meanRgbMax": [max(p["meanRgb"][i] for p in patches) for i in range(3)],
                     "lumaMin": min(lumas), "lumaMax": max(lumas)},
        "patches": patches,
    }
    manifest["features"] = feature_texture(patches, manifest["layout"], atlas_path, output, atlas_pages)
    add_high_detail_assets(manifest, sources, cache, output, args.workers)
    (output / "satellite-mosaic.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    # Publish only once the complete replacement is ready; discovery/downloads
    # cannot leave the running app with an incomplete library.
    for filename in [*[page["url"].lstrip("/") for page in atlas_pages], "satellite-scenes.json", "satellite-mosaic-coasts-lut.png",
                     "satellite-mosaic-terrain-lut.png", "satellite-mosaic-satellite-lut.png", "satellite-features.png", "satellite-mosaic.json"]:
        (PUBLIC / filename).write_bytes((output / filename).read_bytes())
    (cache / "rejected-scenes.json").write_text(json.dumps(failed, indent=2))
    atlas_bytes = sum((output / page["url"].lstrip("/")).stat().st_size for page in atlas_pages)
    print(f"COMPLETE: {len(patches)} distinct wide scenes, {len(sources)} source records, {len(atlas_pages)} base pages, {atlas_bytes:,} JPEG bytes", flush=True)
    print(f"Natural mean luminance {min(lumas):.1f}–{max(lumas):.1f}/255; total elapsed {time.monotonic() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
