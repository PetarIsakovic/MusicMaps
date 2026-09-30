#!/usr/bin/env python3
"""Build photos AND cached map tiles from one fixed EOX Sentinel mosaic.

Requires Pillow + NumPy. Downloads aligned 4x4 WMTS-sized blocks via WMS,
caches them, and keeps their decoded pixels losslessly as normal map tiles.
No image overlays, color edits, invented acquisition dates, or mixed providers.
Run with --publish after reviewing the staged build. Existing assets are backed
up before publication. Rebuilds reuse the pinned selection and cached bytes.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
import importlib.util
from io import BytesIO
import json
import math
from pathlib import Path
import random
import shutil
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

import numpy as np
from PIL import Image, ImageStat, __version__ as PILLOW_VERSION
from imagery_quality import analyze_quality, is_bright_neutral, QUALITY_VERSION

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
CACHE = ROOT / '.cache' / 'consistent-imagery-2025'
STAGE = CACHE / 'build'
COLLECTION = 'eox-sentinel-2025-v1'
LAYER = 's2cloudless-2025_3857'  # Latest complete annual mosaic verified in September 2026.
MOSAIC_YEAR = '2025'
LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
LICENSE_LABEL = 'CC BY-NC-SA 4.0'
ZOOM, BLOCK, COUNT = 9, 4, 16384
BRIGHT_NEUTRAL_QUOTA = 64
MIN_BRIGHT_NEUTRAL_PHOTOS = 8  # Enough distinct natural whites for the eight-candidate lookup.
SELECTION_VERSION = 7
# The polar fringe includes incomplete/false-color processing artifacts in this
# release. Keep photographs inside Sentinel's useful land-coverage latitude band.
MIN_PHOTO_LATITUDE, MAX_PHOTO_LATITUDE = -60, 84
EXTENT = 20037508.342789244
ATTRIBUTION = f'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data {MOSAIC_YEAR})'
SPEC = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-satellite-scenes.py'))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
LOCK = threading.Lock()
next_request = 0.0


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(',', ':')) + '\n')


def tile_xy(lon, lat):
    lat = max(-85, min(85, lat))
    return (int((lon + 180) / 360 * 2**ZOOM) % 2**ZOOM,
            int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**ZOOM))


def lonlat(x, y):
    return [x / 2**ZOOM * 360 - 180,
            math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2**ZOOM))))]


def block_url(x, y):
    step = EXTENT * 2 / 2**ZOOM
    query = {'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap',
             'LAYERS': LAYER, 'STYLES': '', 'SRS': 'EPSG:3857',
             'BBOX': ','.join(map(str, [-EXTENT + x * step, EXTENT - (y + BLOCK) * step,
                                     -EXTENT + (x + BLOCK) * step, EXTENT - y * step])),
             'WIDTH': BLOCK * 256, 'HEIGHT': BLOCK * 256, 'FORMAT': 'image/jpeg'}
    return 'https://tiles.maps.eox.at/wms?' + urlencode(query)


def fetch_block(block):
    global next_request
    x, y = block['x'], block['y']
    path = CACHE / 'blocks' / f'{x}-{y}.jpg'
    if path.exists():
        if block.get('sha256') and sha256(path.read_bytes()).hexdigest() != block['sha256']:
            raise ValueError(f'Pinned map block changed: {path}')
        with Image.open(path) as image:
            if image.size != (1024, 1024):
                raise ValueError(f'Invalid cached block: {path}')
        return block
    for attempt in range(6):
        # Shared pacing and bounded concurrency respect the public service.
        with LOCK:
            wait = max(0, next_request - time.monotonic())
            next_request = max(next_request, time.monotonic()) + 1.0
        time.sleep(wait)
        try:
            request = urllib.request.Request(block_url(x, y), headers={'User-Agent': 'MusicMaps-consistent-imagery/1.0'})
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read()
            with Image.open(BytesIO(data)) as image:
                image.load()
                if image.size != (1024, 1024):
                    raise ValueError('Unexpected map block dimensions')
            if block.get('sha256') and sha256(data).hexdigest() != block['sha256']:
                raise ValueError('Upstream imagery changed; keep the cached version or create a new collection')
            temporary = path.with_suffix('.tmp')
            temporary.write_bytes(data)
            temporary.replace(path)
            return block
        except Exception as error:
            if attempt == 5:
                raise
            delay = min(90, 5 * 2**attempt)
            if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                try:
                    delay = max(delay, float(error.headers.get('Retry-After', 60)))
                except ValueError:
                    delay = max(delay, 60)
                with LOCK:
                    next_request = max(next_request, time.monotonic() + delay)
            print(f'Retrying block {x}/{y} in {delay}s: {error}', flush=True)
            time.sleep(delay)


def ensure_snow_coverage(plan):
    # Random global coverage missed bright neutral terrain. Add real glacier
    # regions from the very same map layer; every tile still passes screening.
    known = {(block['x'], block['y']) for block in plan['blocks']}
    for region, columns, rows in [
        ('Alaska and Canadian icefields', [40, 44, 48, 52, 56, 60], [136, 140, 144, 148]),
        ('Patagonian icefields', [144, 148, 152], [324, 328, 332, 336]),
    ]:
        for x in columns:
            for y in rows:
                if (x, y) not in known:
                    plan['blocks'].append(dict(x=x, y=y, region=region))
                    known.add((x, y))
    # Broaden the natural palette with salt flats, varied coastlines, vegetation,
    # pale rock, volcanic terrain, and settlements. Coordinates identify sampling
    # centers, while labels deliberately describe the wider surrounding region.
    anchors = [
        ('Bolivian salt flats', -67.5, -20.3), ('Atacama region', -68.3, -23.4),
        ('Northern Namibia', 16.2, -18.8), ('Botswana salt pans', 25.5, -20.5),
        ('Utah salt lakes', -112.4, 41.2), ('Great Basin salt flats', -113.5, 40.7),
        ('South Australian salt lakes', 137.8, -31.2), ('Lake Eyre region', 137.4, -28.4),
        ('Yucatan coast', -89.6, 21.1), ('Bahamas banks', -77, 24.4),
        ('Red Sea coast', 38.5, 22.3), ('Persian Gulf coast', 51.5, 25.4),
        ('Namib desert', 15.3, -24.7), ('Central Sahara', 12, 24),
        ('Algerian Sahara', 6, 26), ('Iceland', -18.6, 65),
        ('Columbia Plateau', -119.5, 46.6), ('Oman', 57.3, 21.4),
        ('Amazon basin', -60, -3), ('Congo basin', 23, -2),
        ('Java', 110, -7), ('Netherlands', 5.4, 52.2),
        ('Central Japan', 139.7, 35.7), ('Northern France', 2.35, 48.85),
        ('Central Mexico', -99, 19.4), ('Northern India', 77, 28.6),
        ('Western Australia', 119.3, -29), ('Western China', 90, 40),
        ('Andean plateau', -68, -16), ('Madagascar', 46, -20),
        ('New Zealand', 170, -44), ('Great Barrier Reef region', 148, -20),
    ]
    for region, lon, lat in anchors:
        x, y = tile_xy(lon, lat)
        for dx in [-4, 0, 4]:
            for dy in [-4, 0, 4]:
                key = ((x // BLOCK * BLOCK + dx) % 2**ZOOM, y // BLOCK * BLOCK + dy)
                if key not in known:
                    plan['blocks'].append(dict(x=key[0], y=key[1], region=region))
                    known.add(key)
    save_json(CACHE / 'selection-plan.json', plan)
    return plan


def plan_blocks():
    plan = CACHE / 'selection-plan.json'
    if plan.exists():
        return ensure_snow_coverage(json.loads(plan.read_text()))
    published_plan = PUBLIC / 'imagery-selection.json'
    if published_plan.exists():
        published = json.loads(published_plan.read_text())
        if published.get('collectionId') == COLLECTION:
            save_json(plan, published)
            return ensure_snow_coverage(published)
        # Reuse geographic coverage, never old image bytes or old selected IDs.
        result = dict(collectionId=COLLECTION, curated=published['curated'],
                      blocks=[{key: block[key] for key in ['x', 'y', 'region']} for block in published['blocks']])
        save_json(plan, result)
        return ensure_snow_coverage(result)
    old = json.loads((PUBLIC / 'satellite-scenes.json').read_text())['sources']
    curated = [(-59.8, -3.2), (73.4, 4.2), (-77.5, 25), (6.2, 61.7), (12.8, 52.7),
               (5.3, 51.8), (-93.5, 42), (-100.7, 38.3), (2.35, 48.86), (-122.4, 37.7),
               (31.5, 31.1), (-64.8, -42.9), (15.5, -24.9), (54.7, 22.8), (134.5, -24.9), (8.4, 46.5)]
    first = [dict(x=tile_xy(*p)[0], y=tile_xy(*p)[1], region=old[i]['region'].split(' · ')[0],
                  imageryModes=old[i]['imageryModes']) for i, p in enumerate(curated)]
    blocks, seen = [], set()
    def add(x, y, region):
        key = (x // BLOCK * BLOCK, y // BLOCK * BLOCK)
        if key not in seen:
            seen.add(key)
            blocks.append(dict(x=key[0], y=key[1], region=region))
    for source in first:
        add(source['x'], source['y'], source['region'])
    buckets = {}
    for source in old[16:]:
        west, south, east, north = source['sceneBoundingBox']
        region = source.get('geographicRegion', source['region'].split(' · ')[0])
        buckets.setdefault(region, []).append(tile_xy((west + east) / 2, (south + north) / 2))
    for region, bucket in buckets.items():
        random.Random(region).shuffle(bucket)
    while any(buckets.values()) and len(blocks) < 1100:
        for region in sorted(buckets):
            if buckets[region]:
                add(*buckets[region].pop(), region)
                if len(blocks) >= 1100:
                    break
    result = dict(collectionId=COLLECTION, curated=first, blocks=blocks)
    save_json(plan, result)
    return ensure_snow_coverage(result)


def assess_block(block, pinned):
    records = {}
    x, y = block['x'], block['y']
    raw = (CACHE / 'blocks' / f'{x}-{y}.jpg').read_bytes()
    with Image.open(BytesIO(raw)) as original:
        image = original.convert('RGB')
    for dy in range(BLOCK):
        for dx in range(BLOCK):
            tx, ty = x + dx, y + dy
            tile = image.crop((dx * 256, dy * 256, (dx + 1) * 256, (dy + 1) * 256))
            relative = f'imagery/{COLLECTION}/{ZOOM}/{tx}/{ty}.webp'
            target = STAGE / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = sha256(tile.tobytes()).hexdigest()
            if target.exists():
                try:
                    with Image.open(target) as cached:
                        if sha256(cached.convert('RGB').tobytes()).hexdigest() != digest:
                            target.unlink()
                except (OSError, ValueError):
                    target.unlink()
            if not target.exists():
                temporary = target.with_suffix('.tmp')
                tile.save(temporary, 'WEBP', lossless=True, method=1)
                temporary.replace(target)
            small = tile.resize((64, 64), Image.Resampling.LANCZOS)
            stats = ImageStat.Stat(small)
            quality = analyze_quality(tile)
            rgb = np.array(small)
            water = float(np.mean((rgb[:, :, 2].astype(float) > rgb[:, :, 0] * 1.12)
                                  & (rgb[:, :, 2] > rgb[:, :, 1] * .91)))
            modes = (['coasts'] if water > .06 else []) + (['terrain'] if water < .8 else []) + ['satellite']
            if (tx, ty) in pinned:
                modes = pinned[(tx, ty)]['imageryModes']
            mean = stats.mean
            luma = sum(c * w for c, w in zip(mean, [.2126, .7152, .0722]))
            quadrants = []
            for box in [(0, 0, 32, 32), (32, 0, 64, 32), (0, 32, 32, 64), (32, 32, 64, 64)]:
                q = ImageStat.Stat(small.crop(box)).mean
                quadrants.append((sum(c * w for c, w in zip(q, [.2126, .7152, .0722])) - luma) / 255 * .6)
            records[(tx, ty)] = dict(x=tx, y=ty, region=pinned.get((tx, ty), block)['region'],
                imageryModes=modes, url='/' + relative, thumbnailSha256=sha256(target.read_bytes()).hexdigest(),
                pixelSha256=digest, blockSha256=sha256(raw).hexdigest(), quality=quality,
                meanRgb=[round(float(value), 4) for value in mean],
                descriptor=[*builder.color_feature(mean), *quadrants])
    return records


def assess(plan):
    all_records, records, hashes = {}, {}, set()
    pinned = {(s['x'], s['y']): s for s in plan['curated']}
    # Image codecs release the GIL. Process independent local blocks in parallel,
    # then consume results in plan order so selection remains deterministic.
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i, batch in enumerate(pool.map(lambda block: assess_block(block, pinned), plan['blocks']), 1):
            all_records.update(batch)
            for key, record in batch.items():
                if not record['quality']['accepted']:
                    continue
                digest = record['pixelSha256']
                if digest in hashes and key not in pinned:
                    continue
                hashes.add(digest)
                records[key] = record
            if i % 50 == 0:
                print(f'Encoded {i}/{len(plan["blocks"])} blocks; {len(records)} unique textured photographs', flush=True)
    # Do not choose a clear strip right beside a known missing-data tile.
    # Longitude wraps at the date line, just as it does on the interactive map.
    bad_coverage = {key for key, record in all_records.items()
                    if any(reason.endswith('_missing_data') or reason == 'snow_color_artifacts'
                           for reason in record['quality']['reasons'])}
    near_gaps = {key for key in records if any(((key[0] + dx) % 2**ZOOM, key[1] + dy) in bad_coverage
                                             for dx in [-1, 0, 1] for dy in [-1, 0, 1])}
    for key in near_gaps:
        del records[key]
    outside_coverage = {key for key in records
                        if lonlat(key[0], key[1] + 1)[1] < MIN_PHOTO_LATITUDE
                        or lonlat(key[0], key[1])[1] > MAX_PHOTO_LATITUDE}
    for key in outside_coverage:
        del records[key]
    rejected = [{'tile': list(key), 'reasons': record['quality']['reasons'],
                 'metrics': record['quality']['metrics']}
                for key, record in all_records.items() if not record['quality']['accepted']]
    audit = dict(collectionId=COLLECTION, qualityVersion=QUALITY_VERSION, assessed=len(all_records),
                 rejected=len(rejected), nearMissingDataRejected=len(near_gaps),
                 outsideCoverageRejected=len(outside_coverage), eligible=len(records),
                 images=rejected, nearMissingDataTiles=[list(key) for key in sorted(near_gaps)])
    save_json(CACHE / 'quality-audit.json', audit)
    print(f'Quality: {len(records)} eligible; {len(rejected)} rejected; {len(near_gaps)} near missing coverage; '
          f'{len(outside_coverage)} outside usable latitude band', flush=True)
    candidates = list(records.values())
    if len(candidates) < COUNT:
        raise ValueError(f'Only {len(candidates)} distinct usable photographs; need {COUNT}')
    if plan.get('selectedTiles') and plan.get('selectionVersion') == SELECTION_VERSION:
        return [records[tuple(key)] for key in plan['selectedTiles']]
    points = np.array([r['descriptor'] for r in candidates])
    indices = {(r['x'], r['y']): i for i, r in enumerate(candidates)}
    chosen = []
    for source in plan['curated']:
        key = (source['x'], source['y'])
        if key not in indices:
            # A gallery slot never bypasses screening. Prefer a nearby clean
            # photograph of the same region and landscape type.
            options = [(i, record) for i, record in enumerate(candidates)
                       if record['region'] == source['region'] and i not in chosen
                       and set(source['imageryModes']).issubset(record['imageryModes'])]
            if not options:
                raise ValueError(f'No clean gallery image available near {source["region"]}')
            index, replacement = min(options, key=lambda pair: (pair[1]['x'] - key[0])**2 + (pair[1]['y'] - key[1])**2)
            source.update(x=replacement['x'], y=replacement['y'])
            print(f'Replaced incomplete gallery image near {source["region"]}', flush=True)
        else:
            index = indices[key]
        chosen.append(index)
    # Keep existing good photographs while expanding, so adding capacity cannot
    # throw away a rare useful color such as the snow that fixed white video.
    for key in plan.get('selectedTiles', []):
        index = indices.get(tuple(key))
        if index is not None and index not in chosen and len(chosen) < COUNT:
            chosen.append(index)
    distances = np.full(len(points), np.inf)
    for index in chosen:
        distances = np.minimum(distances, np.sum((points - points[index])**2, axis=1))
    distances[chosen] = -1
    # White-heavy video needs genuine bright, neutral candidates. Reserve a
    # deterministic palette quota before geographic farthest-point sampling so
    # warm deserts cannot crowd snow, ice, and pale terrain out of the matcher.
    bright_neutral = []
    for index, record in enumerate(candidates):
        if index in chosen:
            continue
        if is_bright_neutral(record['meanRgb']):
            bright_neutral.append(index)
    bright_neutral.sort(key=lambda index: (-sum(candidates[index]['meanRgb']),
                                           candidates[index]['x'], candidates[index]['y']))
    retained_bright = sum(is_bright_neutral(candidates[index]['meanRgb']) for index in chosen)
    if len(bright_neutral) + retained_bright < MIN_BRIGHT_NEUTRAL_PHOTOS:
        raise ValueError(f'Only {len(bright_neutral)} genuinely bright neutral photos; '
                         f'need {MIN_BRIGHT_NEUTRAL_PHOTOS}. Expand clean snow coverage before publishing.')
    additions = bright_neutral[:max(0, min(BRIGHT_NEUTRAL_QUOTA - retained_bright, COUNT - len(chosen)))]
    for index in additions:
        chosen.append(index)
        distances = np.minimum(distances, np.sum((points - points[index])**2, axis=1))
    distances[chosen] = -1
    print(f'Palette: retained {retained_bright} and added {len(additions)} bright neutral scenes', flush=True)
    while len(chosen) < COUNT:
        index = int(np.argmax(distances))
        chosen.append(index)
        distances = np.minimum(distances, np.sum((points - points[index])**2, axis=1))
        distances[index] = -1
    plan['selectionVersion'] = SELECTION_VERSION
    plan['selectedTiles'] = [[candidates[index]['x'], candidates[index]['y']] for index in chosen]
    save_json(CACHE / 'selection-plan.json', plan)
    return [candidates[i] for i in chosen]


def build(records, plan):
    sources, patches = [], []
    for i, record in enumerate(records):
        x, y = record['x'], record['y']
        west, north = lonlat(x, y)
        east, south = lonlat(x + 1, y + 1)
        source = dict(index=i, column=i % 4, row=i // 4, region=record['region'],
            itemId=f'{COLLECTION}:{ZOOM}/{x}/{y}', gridCode=f'{ZOOM}/{x}/{y}', collection=COLLECTION,
            sceneBoundingBox=[west, south, east, north], thumbnailUrl=record['url'],
            thumbnailDimensions=[256, 256], cropPixels=[0, 0, 256, 256],
            thumbnailSha256=record['thumbnailSha256'], pixelSha256=record['pixelSha256'],
            quality={key: record['quality'][key] for key in ['version', 'accepted', 'reasons']},
            imageryModes=record['imageryModes'], mapTile=dict(collectionId=COLLECTION, z=ZOOM, x=x, y=y, tileSize=256),
            provenance=dict(layer=LAYER, mosaicPeriod=MOSAIC_YEAR, blockUrl=block_url(x // BLOCK * BLOCK, y // BLOCK * BLOCK),
                            blockSha256=record['blockSha256']))
        sources.append(source)
        patches.append(dict(index=i, sourceIndex=i, column=i % 64, row=i // 64, meanRgb=[],
            cropPixels=source['cropPixels'], previewUrl=record['url'], previewWidth=256, previewHeight=256))
    base_pages = builder.page_layouts(COUNT, 64, 'satellite-mosaic')
    detail_pages = builder.page_layouts(COUNT, 128, 'satellite-mosaic-detail')
    for pages in [base_pages, detail_pages]:
        for page_index, page in enumerate(pages):
            size = page['tileSize']
            atlas = Image.new('RGB', (page['width'], page['height']))
            page_patches = patches[page_index * 4096:(page_index + 1) * 4096]
            for patch in page_patches:
                with Image.open(STAGE / patch['previewUrl'].lstrip('/')) as tile:
                    atlas.paste(tile.resize((size, size), Image.Resampling.LANCZOS),
                                (patch['column'] * size, patch['row'] % 64 * size))
            path = STAGE / page['url'].lstrip('/')
            atlas.save(path, quality=95 if size == 64 else 92, subsampling=0, optimize=True)
            atlas.close()
            if size == 64:
                with Image.open(path) as decoded:
                    for patch in page_patches:
                        left, top = patch['column'] * size, patch['row'] % 64 * size
                        patch['meanRgb'] = [round(v, 4) for v in ImageStat.Stat(decoded.crop((left, top, left + size, top + size))).mean]
            print(f'Built {page["url"]}: {path.stat().st_size:,} bytes', flush=True)
    curated = Image.new('RGB', (1024, 1024))
    for i, patch in enumerate(patches[:16]):
        with Image.open(STAGE / patch['previewUrl'].lstrip('/')) as tile:
            curated.paste(tile, (i % 4 * 256, i // 4 * 256))
    curated.save(STAGE / 'satellite-atlas.jpg', quality=95, subsampling=0)
    attribution = dict(attribution=ATTRIBUTION, provider='EOX IT Services GmbH', hosting='EOX::Maps and bundled immutable map tiles',
                       registryUrl='https://maps.eox.at/', licenseUrl=LICENSE_URL, licenseLabel=LICENSE_LABEL)
    collection = dict(id=COLLECTION, title=f'EOxCloudless {MOSAIC_YEAR}', layer=LAYER, mosaicPeriod=MOSAIC_YEAR,
        releaseDate='2026-06-15', releaseUrl='https://eox.at/2026/06/eoxcloudless-2025/', qualityVersion=QUALITY_VERSION,
        tileSize=256, minZoom=2, maxNativeZoom=14, maxZoom=14,
        remoteTileUrl=f'https://tiles.maps.eox.at/wmts/1.0.0/{LAYER}/default/g/{{z}}/{{y}}/{{x}}.jpg',
        localTileUrl=f'/imagery/{COLLECTION}/{{z}}/{{x}}/{{y}}.webp',
        cachedZoom=ZOOM, cachedBlockSize=BLOCK, cachedBlocks=[[b['x'], b['y']] for b in plan['blocks']], **attribution)
    save_json(STAGE / 'imagery-collection.json', collection)
    scene_manifest = dict(title='Satellite photos from the same pinned mosaic as the interactive map',
        collectionId=COLLECTION, **attribution,
        processing='Full Web Mercator map tiles, lossless WebP decoded pixels. Mosaic combines acquisitions from 2025; no per-photo acquisition date is claimed.', sources=sources)
    save_json(STAGE / 'satellite-scenes.json', scene_manifest)
    save_json(STAGE / 'satellite-sources.json', {**scene_manifest, 'sources': sources[:16]})
    layout = dict(columns=64, rows=COUNT // 64, tileSize=64, width=4096, height=COUNT)
    manifest = dict(title='Consistent Sentinel map photomosaic', atlas='/satellite-mosaic.jpg', atlasPages=base_pages,
        detailPages=detail_pages, detailAtlas=detail_pages[0], layout=layout, sourceManifest='/satellite-scenes.json',
        collectionId=COLLECTION, **attribution, processing='Only resize and encode the same pinned map pixels; no recoloring.',
        build=dict(script='scripts/build-consistent-imagery.py', pillowVersion=PILLOW_VERSION, distinctSceneCount=COUNT,
                   patchesPerSource=1, jpegQuality=95, jpegSubsampling=0, nativePreviewCount=COUNT, nativePreviewFormat='lossless WebP'),
        patches=patches)
    bright_count = sum(is_bright_neutral(patch['meanRgb']) for patch in patches)
    if bright_count < MIN_BRIGHT_NEUTRAL_PHOTOS:
        raise ValueError('The delivered atlas lost its required bright neutral palette during encoding')
    manifest['palette'] = dict(brightNeutralCount=bright_count, minimumBrightNeutralCount=MIN_BRIGHT_NEUTRAL_PHOTOS,
                              minimumLuminance=200, maximumChannelSpread=25)
    audit = json.loads((CACHE / 'quality-audit.json').read_text())
    manifest['quality'] = {key: audit[key] for key in ['qualityVersion', 'assessed', 'rejected', 'nearMissingDataRejected', 'outsideCoverageRejected', 'eligible']}
    manifest['quality']['selected'] = len(patches)
    save_json(STAGE / 'imagery-quality.json', {**manifest['quality'], 'collectionId': COLLECTION,
        'latitudeBounds': [MIN_PHOTO_LATITUDE, MAX_PHOTO_LATITUDE],
        'policy': 'Reject featureless images, rectangular missing-data regions, polar color artifacts, adjacent known gaps, and unsupported latitude coverage. Retain natural snow with distributed mountain detail and irregular boundaries. Preserve original image pixels.'})
    manifest['features'] = builder.feature_texture(patches, layout, STAGE / 'satellite-mosaic.jpg', STAGE, base_pages)
    manifest['lookup'] = builder.lookup_tables(patches, sources, STAGE)
    save_json(STAGE / 'satellite-mosaic.json', manifest)
    print(f'COMPLETE: {COUNT} photographs; {len(plan["blocks"]) * 16} cached continuous map tiles.', flush=True)


def publish():
    manifest = json.loads((STAGE / 'satellite-mosaic.json').read_text())
    scene_manifest = json.loads((STAGE / 'satellite-scenes.json').read_text())
    collection = json.loads((STAGE / 'imagery-collection.json').read_text())
    if (len(manifest['patches']) != COUNT or len(scene_manifest['sources']) != COUNT
            or collection['id'] != COLLECTION or collection['layer'] != LAYER
            or manifest['collectionId'] != collection['id'] or scene_manifest['collectionId'] != collection['id']):
        raise ValueError('Staged library is incomplete or uses different collections')
    if sum(is_bright_neutral(patch['meanRgb']) for patch in manifest['patches']) < MIN_BRIGHT_NEUTRAL_PHOTOS:
        raise ValueError('Cannot publish a library without enough natural white imagery')
    required = [p['url'] for p in manifest['atlasPages'] + manifest['detailPages']]
    required += list(manifest['lookup']['urls'].values()) + [manifest['features']['url'], '/satellite-atlas.jpg']
    required += [p['previewUrl'] for p in manifest['patches']]
    for url in required:
        if not (STAGE / url.lstrip('/')).is_file():
            raise ValueError(f'Missing staged asset: {url}')
    for source in scene_manifest['sources']:
        if source['sceneBoundingBox'][1] < MIN_PHOTO_LATITUDE or source['sceneBoundingBox'][3] > MAX_PHOTO_LATITUDE:
            raise ValueError(f'Photograph is outside usable latitude coverage: {source["itemId"]}')
        if sha256((STAGE / source['thumbnailUrl'].lstrip('/')).read_bytes()).hexdigest() != source['thumbnailSha256']:
            raise ValueError(f'Photograph changed: {source["itemId"]}')
        with Image.open(STAGE / source['thumbnailUrl'].lstrip('/')) as photo:
            if not analyze_quality(photo)['accepted']:
                raise ValueError(f'Incomplete photograph cannot be published: {source["itemId"]}')
    for x, y in collection['cachedBlocks']:
        for dy in range(collection['cachedBlockSize']):
            for dx in range(collection['cachedBlockSize']):
                url = (collection['localTileUrl'].replace('{z}', str(collection['cachedZoom']))
                       .replace('{x}', str(x + dx)).replace('{y}', str(y + dy)))
                if not (STAGE / url.lstrip('/')).is_file():
                    raise ValueError(f'Missing adjacent map tile: {url}')
    # Publish the exact geographic selection so rebuilding does not rediscover
    # a different collection if the local download cache is later removed.
    plan = json.loads((CACHE / 'selection-plan.json').read_text())
    for block in plan['blocks']:
        block['sha256'] = sha256((CACHE / 'blocks' / f'{block["x"]}-{block["y"]}.jpg').read_bytes()).hexdigest()
    plan['selectedTiles'] = [[s['mapTile']['x'], s['mapTile']['y']] for s in scene_manifest['sources']]
    save_json(STAGE / 'imagery-selection.json', plan)
    save_json(CACHE / 'selection-plan.json', plan)
    backup = CACHE / 'previous-library'
    backup.mkdir(exist_ok=True)
    for path in STAGE.iterdir():
        target = PUBLIC / path.name
        if target.exists() and not (backup / path.name).exists():
            if target.is_dir():
                shutil.copytree(target, backup / path.name)
            else:
                shutil.copy2(target, backup / path.name)
        if path.is_dir():
            shutil.copytree(path, target, dirs_exist_ok=True)
        else:
            temporary = target.with_suffix(target.suffix + '.tmp')
            shutil.copy2(path, temporary)
            temporary.replace(target)
    # Old collections remain backed up, but do not ship them with the new site.
    for retired_collection in (PUBLIC / 'imagery').iterdir():
        if retired_collection.is_dir() and retired_collection.name != collection['id']:
            if not (backup / 'imagery' / retired_collection.name).is_dir():
                raise ValueError('Refusing to retire imagery without its backup')
            shutil.rmtree(retired_collection)
    # The retired previews are no longer referenced. Keep them out of static
    # builds, but retain a reversible backup alongside their old manifests.
    retired = PUBLIC / 'satellite-scenes'
    if retired.exists() and not (backup / 'satellite-scenes').exists():
        retired.rename(backup / 'satellite-scenes')
    print('Published library. Previous manifests and atlases are backed up in .cache/consistent-imagery-2025/previous-library.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--publish-only', action='store_true')
    parser.add_argument('--download-only', action='store_true', help='Populate cache without building or publishing assets')
    args = parser.parse_args()
    (CACHE / 'blocks').mkdir(parents=True, exist_ok=True)
    STAGE.mkdir(exist_ok=True)
    if not args.publish_only:
        plan = plan_blocks()
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(fetch_block, block) for block in plan['blocks']]
            for i, job in enumerate(as_completed(jobs), 1):
                job.result()
                if i % 25 == 0:
                    print(f'Map blocks: {i}/{len(jobs)}; elapsed {time.monotonic() - started:.0f}s', flush=True)
        if args.download_only:
            print('Downloads complete.', flush=True)
            return
        records = assess(plan)
        build(records, plan)
    if args.publish or args.publish_only:
        publish()


if __name__ == '__main__':
    main()
