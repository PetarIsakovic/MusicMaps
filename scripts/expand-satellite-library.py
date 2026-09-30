#!/usr/bin/env python3
"""Append distinct geographic scenes selected for new colors and light/dark patterns.

Requires Pillow and NumPy. Preserves all existing scene IDs and atlas positions.
Downloads public RGB thumbnails to a local cache, then selects additions by
farthest-point sampling in color + quadrant-luminance space. No image recoloring.
"""
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor, as_completed
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image, ImageStat

SPEC = importlib.util.spec_from_file_location('scene_builder', Path(__file__).with_name('build-satellite-scenes.py'))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def grid(source):
    return source.get('gridCode', source['itemId'].split('_')[1]).removeprefix('MGRS-')


def descriptor(tile):
    mean = ImageStat.Stat(tile).mean
    luma = sum(c * weight for c, weight in zip(mean, (0.2126, 0.7152, 0.0722)))
    half = tile.width // 2
    pattern = []
    for box in [(0, 0, half, half), (half, 0, tile.width, half),
                (0, half, half, tile.height), (half, half, tile.width, tile.height)]:
        rgb = ImageStat.Stat(tile.crop(box)).mean
        pattern.append((sum(c * w for c, w in zip(rgb, (0.2126, 0.7152, 0.0722))) - luma) / 255 * .6)
    return [*builder.color_feature(mean), *pattern]


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=12288)
    parser.add_argument('--workers', type=int, default=12)
    parser.add_argument('--cache-dir', type=Path, default=Path(tempfile.gettempdir()) / 'musicmaps-satellite-scenes-cache')
    parser.add_argument('--candidates-file', type=Path, help='Optional geographic discovery JSON; see discover-satellite-scenes.py')
    args = parser.parse_args()
    if not 2048 <= args.count <= 12288:
        parser.error('--count must be between 2048 and 12288 (up to three 4096px texture pages)')
    cache = args.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((builder.PUBLIC / 'satellite-mosaic.json').read_text())
    source_manifest = json.loads((builder.PUBLIC / manifest['sourceManifest'].lstrip('/')).read_text())
    sources = source_manifest['sources']
    if len(sources) != len(manifest['patches']) or any(source['index'] != i for i, source in enumerate(sources)):
        raise ValueError('Expansion requires contiguous source IDs and one atlas patch per source')
    needed = args.count - len(sources)
    if needed <= 0:
        print(f'Library already contains {len(sources)} scenes; no additions needed.')
        return
    started = time.monotonic()
    discovery = args.candidates_file or cache / 'expanded-discovery-candidates.json'
    if not discovery.exists():
        discovery = cache / 'discovered-candidates.json'
    if discovery.exists():
        candidates = json.loads(discovery.read_text())
    else:
        catalog_cache = cache / 'catalog'
        catalog_cache.mkdir(exist_ok=True)
        candidates = []
        for region in builder.REGIONS:
            name, items = builder.search_region(region, catalog_cache)
            candidates.extend(builder.source_from_item(item, name) for item in items)
        discovery.write_text(json.dumps(candidates, separators=(',', ':')))
    seen_grids = {grid(source) for source in sources}
    seen_ids = {source['itemId'] for source in sources}
    seen_hashes = {source['thumbnailSha256'] for source in sources}
    unseen = []
    for source in candidates:
        if grid(source) in seen_grids or source['itemId'] in seen_ids:
            continue
        seen_grids.add(grid(source)); seen_ids.add(source['itemId'])
        unseen.append(source)
    valid, rejected = {}, []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(builder.download_source, dict(source), cache): i for i, source in enumerate(unseen)}
        for job in as_completed(jobs):
            index = jobs[job]
            try:
                source, tile = job.result()
                stats = ImageStat.Stat(tile)
                if min(stats.mean) > 244 and max(stats.stddev) < 2:
                    raise ValueError('Featureless white thumbnail')
                valid[index] = (source, descriptor(tile))
            except Exception as error:
                rejected.append((index, str(error)))
            if (len(valid) + len(rejected)) % 256 == 0:
                print(f'Assessed {len(valid)+len(rejected)}/{len(unseen)} new geographic scenes', flush=True)
    candidates, features = [], []
    for index in sorted(valid):
        source, feature = valid[index]
        if source['thumbnailSha256'] in seen_hashes:
            continue
        seen_hashes.add(source['thumbnailSha256'])
        candidates.append(source); features.append(feature)
    if len(candidates) < needed:
        raise ValueError(f'Only {len(candidates)} valid unique additions found; need {needed}')
    pages = manifest.get('atlasPages', [dict(url=manifest['atlas'], **manifest['layout'])])
    existing_features = []
    row_offset = 0
    for page in pages:
        with Image.open(builder.PUBLIC / page['url'].lstrip('/')) as raw:
            atlas = raw.convert('RGB')
        size = page['tileSize']
        for patch in manifest['patches'][row_offset*page['columns']:(row_offset+page['rows'])*page['columns']]:
            x, y = patch['column']*size, (patch['row']-row_offset)*size
            existing_features.append(descriptor(atlas.crop((x,y,x+size,y+size))))
        atlas.close()
        row_offset += page['rows']
    existing = np.array(existing_features, dtype=np.float64)
    points = np.array(features, dtype=np.float64)
    # Start with distance to the existing library, then repeatedly fill the
    # largest remaining gap. Selection never replaces a known useful scene.
    distances = np.full(len(points), np.inf)
    for start in range(0, len(existing), 128):
        delta = points[:, None, :] - existing[None, start:start+128, :]
        distances = np.minimum(distances, np.min(np.sum(delta * delta, axis=2), axis=1))
    before = distances.copy()
    chosen = []
    for _ in range(needed):
        index = int(np.argmax(distances))
        chosen.append(index)
        delta = points - points[index]
        distances = np.minimum(distances, np.sum(delta * delta, axis=1))
        distances[chosen] = -1
    after = np.maximum(distances, 0)
    additions = []
    for index in chosen:
        source = candidates[index]
        source['index'] = len(sources) + len(additions)
        additions.append(source)
    report = {
        'previousSceneCount': len(sources), 'addedSceneCount': len(additions),
        'assessedUniqueCandidates': len(candidates),
        'selection': 'Preserve existing source IDs and crops; append geographic and thumbnail-hash unique scenes by farthest-point color + quadrant-luminance novelty.',
        'descriptor': 'Weighted OKLab (L×1.35) + four mean-centered Rec.709 quadrant luminances×0.6.',
        'candidateMeanSquaredDistanceBefore': float(np.mean(before)),
        'candidateMeanSquaredDistanceAfter': float(np.mean(after)),
        'candidateWorstSquaredDistanceBefore': float(np.max(before)),
        'candidateWorstSquaredDistanceAfter': float(np.max(after)),
    }
    source_manifest['sources'] = sources + additions
    source_manifest['expansion'] = report
    prepared = cache / 'expanded-sources.json'
    prepared.write_text(json.dumps(source_manifest, separators=(',', ':')) + '\n')
    (cache / 'expansion-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    print(f'Building {args.count} scenes; selection took {time.monotonic()-started:.1f}s', flush=True)
    subprocess.run([sys.executable, str(Path(__file__).with_name('build-satellite-scenes.py')),
                    '--sources-file', str(prepared), '--count', str(args.count),
                    '--workers', str(args.workers), '--cache-dir', str(cache)], check=True)


if __name__ == '__main__':
    main()
