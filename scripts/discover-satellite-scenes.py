#!/usr/bin/env python3
"""Discover additional public Sentinel-2 grids across regions and seasons.

Writes a cached candidate JSON for expand-satellite-library.py. Only metadata is
fetched here; the expander verifies RGB thumbnails, wide crops and uniqueness.
"""
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
from urllib.parse import urlencode, urlparse, parse_qs

SPEC = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-satellite-scenes.py'))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
EXTRA_REGIONS = [
    ('Northern Canada', [-140, 58, -52, 83]),
    ('Far Eastern Russia', [145, 45, 179.9, 72]),
    ('Northeastern Russia', [-179.9, 60, -169, 72]),
    ('Western Antarctica', [-179.9, -80, -80, -62]),
    ('Eastern Antarctic coast', [145, -80, 179.9, -62]),
]


def discover(region, month, cache):
    name, bounds = region
    query = {
        'collections': 'sentinel-2-l2a', 'bbox': ','.join(map(str, bounds)),
        'datetime': f'2024-{month}-01T00:00:00Z/2024-{month}-28T23:59:59Z', 'limit': 500,
        'query': json.dumps({'eo:cloud_cover': {'lt': 8}, 's2:nodata_pixel_percentage': {'lt': 1}}),
        'fields': 'properties.eo:cloud_cover,properties.grid:code,properties.s2:nodata_pixel_percentage,'
                  'properties.s2:water_percentage,properties.s2:snow_ice_percentage,'
                  'properties.earthsearch:s3_path,-assets,-geometry,-links,-stac_extensions,-stac_version',
    }
    grids = {}
    for _ in range(12):
        path = cache / (sha256(json.dumps(query, sort_keys=True).encode()).hexdigest()[:20] + '.json')
        if not path.exists():
            path.write_bytes(builder.request_bytes(builder.API + '/search?' + urlencode(query)))
        data = json.loads(path.read_text())
        for item in data.get('features', []):
            props = item['properties']; grid = props.get('grid:code'); bbox = item.get('bbox', [])
            if not grid or not props.get('earthsearch:s3_path') or len(bbox) != 4 or not 0 < bbox[2]-bbox[0] <= 30:
                continue
            if grid not in grids or props['eo:cloud_cover'] < grids[grid]['properties']['eo:cloud_cover']:
                grids[grid] = item
        link = next((link for link in data.get('links', []) if link.get('rel') == 'next'), None)
        if not link:
            break
        # Earth Search serializes fields differently in next links. Keep the
        # valid original CSV fields and extract only the pagination cursor.
        query['next'] = parse_qs(urlparse(link['href']).query)['next'][0]
    print(f'{name} / 2024-{month}: {len(grids)} geographic scenes', flush=True)
    return [builder.source_from_item(item, name) for item in grids.values()]


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=Path(tempfile.gettempdir())/'musicmaps-satellite-scenes-cache')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    catalog = args.cache_dir/'catalog-seasons'; catalog.mkdir(parents=True, exist_ok=True)
    output = args.cache_dir/'expanded-discovery-candidates.json'
    seen = {}
    for file in [args.cache_dir/'discovered-candidates.json', output]:
        if file.exists():
            for source in json.loads(file.read_text()):
                seen.setdefault(source.get('gridCode', 'MGRS-'+source['itemId'].split('_')[1]), source)
    work = [(region, month) for region in builder.REGIONS+EXTRA_REGIONS
            for month in (['01', '02', '03', '04'] if region[1][1] < -5 else ['05', '06', '07', '09'])]
    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(discover, region, month, catalog): index for index, (region, month) in enumerate(work)}
        for job in as_completed(jobs):
            results[jobs[job]] = job.result()
    for index in sorted(results):
        for source in results[index]:
            seen.setdefault(source['gridCode'], source)
    output.write_text(json.dumps(list(seen.values()), separators=(',', ':')) + '\n')
    print(f'Saved {len(seen)} unique geographic candidates to {output}', flush=True)


if __name__ == '__main__':
    main()
