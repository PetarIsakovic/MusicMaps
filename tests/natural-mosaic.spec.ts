import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mosaicAtlasPages, mosaicDetailPages, readMosaicAssets } from './mosaic-assertions';

test('the imagery library contains thousands of distinct satellite scenes with wide, valid image views', () => {
  test.setTimeout(120_000);
  const { mosaic, sources } = readMosaicAssets();
  const scenes = new Map(sources.map(source => [source.index, source]));
  const sceneIds = new Set<string>();
  const imageURLs = new Set<string>();
  const geographicTiles = new Set<string>();
  const positions = new Set<string>();
  const patchIndices = new Set<number>();
  const sourceIndices = new Set<number>();
  const thumbnailHashes = new Set<string>();
  const previewURLs = new Set<string>();
  const narrow: number[] = [];
  const invalid: number[] = [];
  const missingSources: number[] = [];
  const invalidPreviews: number[] = [];
  for (const patch of mosaic.patches) {
    const source = scenes.get(patch.sourceIndex);
    if (!source) { missingSources.push(patch.index); continue; }
    sceneIds.add(source.itemId);
    imageURLs.add(source.thumbnailUrl);
    thumbnailHashes.add(source.thumbnailSha256);
    previewURLs.add(patch.previewUrl);
    const preview = readFileSync(`public${patch.previewUrl}`);
    if (preview.subarray(0, 4).toString() !== 'RIFF' || preview.subarray(8, 12).toString() !== 'WEBP')
      invalidPreviews.push(patch.index);
    geographicTiles.add(source.gridCode?.replace(/^MGRS-/, '') ?? source.itemId.split('_')[1]);
    patchIndices.add(patch.index);
    sourceIndices.add(patch.sourceIndex);
    positions.add(`${patch.column},${patch.row}`);
    const [width, height] = source.thumbnailDimensions;
    const [left, top, right, bottom] = patch.cropPixels;
    if (Math.min(right - left, bottom - top) < Math.min(width, height) * .7) narrow.push(patch.index);
    if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top
      || patch.column < 0 || patch.column >= mosaic.layout.columns || patch.row < 0 || patch.row >= mosaic.layout.rows
      || patch.index !== patch.row * mosaic.layout.columns + patch.column)
      invalid.push(patch.index);
  }
  expect(missingSources, 'Every patch must identify its original satellite scene').toEqual([]);
  expect(invalidPreviews, 'Each native preview must be a real WebP file with RIFF and WEBP headers').toEqual([]);
  expect(sceneIds.size, 'The expanded library must contain 16,384 distinct map photographs').toBe(16384);
  expect(geographicTiles.size, 'Each image must show a different geographic grid location').toBe(16384);
  expect(previewURLs.size).toBe(16384);
  expect(thumbnailHashes.size, 'Every map photograph must have distinct content').toBe(16384);
  const collection = JSON.parse(readFileSync('public/imagery-collection.json', 'utf8'));
  expect(collection).toMatchObject({ id: 'eox-sentinel-2025-v1', layer: 's2cloudless-2025_3857',
    mosaicPeriod: '2025', releaseDate: '2026-06-15', qualityVersion: 2,
    licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' });
  const quality = JSON.parse(readFileSync('public/imagery-quality.json', 'utf8'));
  expect(quality).toMatchObject({ collectionId: collection.id, qualityVersion: 2, selected: 16384 });
  expect(quality.eligible).toBeGreaterThanOrEqual(quality.selected);
  expect(quality.rejected, 'The missing-data screening must actually reject incomplete candidates').toBeGreaterThan(0);
  expect(mosaic.collectionId).toBe(collection.id);
  const blocks = new Set(collection.cachedBlocks.map(([x, y]: number[]) => `${x}/${y}`));
  const sourceFailures: { index: number; checks: string[] }[] = [];
  for (const source of sources) {
    const tile = source.mapTile;
    const checks: string[] = [];
    if (source.quality?.version !== collection.qualityVersion || !source.quality?.accepted
      || source.quality.reasons.length) checks.push('image quality');
    if (source.provenance?.layer !== collection.layer || source.provenance?.mosaicPeriod !== collection.mosaicPeriod)
      checks.push('imagery year');
    if (source.sceneBoundingBox[1] < -60 || source.sceneBoundingBox[3] > 84) checks.push('polar fringe');
    if (tile.collectionId !== collection.id) checks.push('collection ID');
    if (tile.z !== collection.cachedZoom) checks.push('cached zoom');
    if (tile.tileSize !== 256) checks.push('tile size');
    if (!blocks.has(`${Math.floor(tile.x / 4) * 4}/${Math.floor(tile.y / 4) * 4}`)) checks.push('cached block');
    if (source.thumbnailUrl !== collection.localTileUrl.replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x)).replace('{y}', String(tile.y))) checks.push('tile URL coordinates');
    // Hash every source file, even when an earlier metadata check has failed.
    if (createHash('sha256').update(readFileSync(`public${source.thumbnailUrl}`)).digest('hex')
      !== source.thumbnailSha256) checks.push('file SHA-256');
    if (source.cropPixels.length !== 4 || source.cropPixels.some((value, index) => value !== [0, 0, 256, 256][index]))
      checks.push('full native crop');
    if (source.thumbnailDimensions.length !== 2 || source.thumbnailDimensions.some(value => value !== 256))
      checks.push('native dimensions');
    if (mosaic.patches[source.index]?.previewUrl !== source.thumbnailUrl) checks.push('photo/map URL identity');
    if (checks.length) sourceFailures.push({ index: source.index, checks });
  }
  expect(sourceFailures, 'Every photograph must retain its exact collection, map tile, native crop, and file hash').toEqual([]);
  expect(mosaic.layout).toMatchObject({ columns: 64, rows: 256, tileSize: 64, width: 4096, height: 16384 });
  expect(mosaic.atlasPages).toHaveLength(4);
  expect(mosaic.detailPages).toHaveLength(4);
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const suffix = pageIndex ? `-${pageIndex}` : '';
    for (const [atlas, tileSize, name] of [
      [mosaic.atlasPages![pageIndex], 64, 'satellite-mosaic'],
      [mosaic.detailPages![pageIndex], 128, 'satellite-mosaic-detail'],
    ] as const) {
      expect(atlas).toEqual({ url: `/${name}${suffix}.jpg`, columns: 64, rows: 64, tileSize,
        width: tileSize * 64, height: tileSize * 64 });
      expect(readFileSync(`public${atlas.url}`).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
  }
  expect(mosaic.detailAtlas).toMatchObject(mosaic.detailPages![0]);
  const features = readFileSync(`public${mosaic.features.url}`);
  expect(features.readUInt32BE(16)).toBe(128);
  expect(features.readUInt32BE(20)).toBe(256);
  expect(sceneIds.size, 'Each atlas image must come from a different geographic tile in the same mosaic').toBe(mosaic.patches.length);
  expect(imageURLs.size).toBe(mosaic.patches.length);
  expect(sourceIndices.size).toBe(mosaic.patches.length);
  expect(patchIndices.size).toBe(mosaic.patches.length);
  expect(positions.size, 'Atlas scenes must occupy separate image slots').toBe(mosaic.patches.length);
  expect(narrow, 'Every image view must retain at least 70% of the original thumbnail’s shorter side').toEqual([]);
  expect(invalid, 'All crops and atlas positions must remain within their source images').toEqual([]);
});

test('the renderer chooses natural imagery colors without tinting them to the video or contrast setting', async ({ page }) => {
  const { mosaic, sources } = readMosaicAssets();
  // Flat patches make recoloring observable at the framebuffer: every interior
  // pixel must retain a supplied image color. Keep the production metadata and
  // color lookup tables so this also exercises the real matching path.
  const patches = mosaic.patches.map(patch => ({ ...patch, meanRgb: patch.meanRgb.map(Math.round) as [number, number, number] }));
  for (const pages of [mosaicAtlasPages(mosaic), mosaicDetailPages(mosaic)]) {
    let startRow = 0;
    for (const atlas of pages) {
      const { width, height, tileSize, rows } = atlas;
      const pagePatches = patches.filter(patch => patch.row >= startRow && patch.row < startRow + rows);
      const flatAtlas = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${pagePatches.map(patch =>
        `<rect x="${patch.column * tileSize}" y="${(patch.row - startRow) * tileSize}" width="${tileSize}" height="${tileSize}" fill="rgb(${patch.meanRgb.join(',')})"/>`,
      ).join('')}</svg>`;
      await page.route(`**${atlas.url}`, route => route.fulfill({ contentType: 'image/svg+xml', body: flatAtlas }));
      startRow += rows;
    }
  }
  await page.goto('/');
  const sourceGroups = Object.fromEntries(['coasts', 'terrain', 'satellite'].map(mode => [mode,
    sources.filter(source => source.imageryModes.includes(mode as 'coasts' | 'terrain' | 'satellite')).map(source => source.index),
  ]));
  const results = await page.evaluate(async ({ patches, sourceGroups }) => {
    const moduleURL = '/src/satellite-renderer.ts';
    const { SatelliteRenderer } = await import(moduleURL);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:768px;height:512px;z-index:9999';
    document.body.append(canvas);
    const renderer = new SatelliteRenderer(canvas);
    await renderer.loadAtlas();
    const source = document.createElement('canvas');
    source.width = 192;
    source.height = 128;
    const context = source.getContext('2d')!;
    context.fillRect(0, 0, source.width, source.height);
    const stream = source.captureStream(30);
    const video = document.createElement('video');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
    document.body.append(video);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const paint = window.setInterval(() => context.fillRect(0, 0, source.width, source.height), 16);
    await video.play();
    const gl = canvas.getContext('webgl')!;
    const samples = [
      { color: [0, 0, 0], contrast: 1, mode: 'satellite' },
      { color: [255, 255, 255], contrast: 1, mode: 'satellite' },
      { color: [230, 60, 30], contrast: 1, mode: 'satellite' },
      { color: [40, 150, 75], contrast: 1, mode: 'satellite' },
      { color: [170, 170, 170], contrast: .7, mode: 'satellite' },
      { color: [170, 170, 170], contrast: 1.6, mode: 'satellite' },
      { color: [230, 60, 30], contrast: 1, mode: 'coasts' },
      { color: [230, 60, 30], contrast: 1, mode: 'terrain' },
    ];
    const frame = () => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Synthetic video did not decode its next canvas frame.')), 2000);
      video.requestVideoFrameCallback(() => { window.clearTimeout(timeout); resolve(); });
    });
    const results = [];
    for (const sample of samples) {
      context.fillStyle = `rgb(${sample.color.join(',')})`;
      context.fillRect(0, 0, source.width, source.height);
      // Let the generated frame reach the normal HTMLVideoElement decoder.
      await frame();
      context.fillRect(0, 0, source.width, source.height);
      await frame();
      renderer.clearSelection();
      renderer.setImageryMode(sample.mode);
      renderer.setSettings({ density: 24, organic: 0, contrast: sample.contrast });
      renderer.render(video, video.currentTime);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const palette = new Set<number>();
      const eligibleSources = new Set(sourceGroups[sample.mode]);
      for (const patch of patches.filter(patch => eligibleSources.has(patch.sourceIndex))) {
        const [r, g, b] = patch.meanRgb;
        // One byte of tolerance covers WebGL dithering, without admitting any
        // exposure, grayscale, tint, or video-color multiplication.
        for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++)
          palette.add(((r + dr) << 16) | ((g + dg) << 8) | (b + db));
      }
      let natural = 0;
      let count = 0;
      let brightness = 0;
      let interior: { x: number; y: number; color: number[] } | null = null;
      for (let offset = 0; offset < pixels.length; offset += 4 * 7) {
        const [r, g, b] = pixels.subarray(offset, offset + 3);
        if (palette.has((r << 16) | (g << 8) | b)) {
          natural++;
          const x = offset / 4 % canvas.width;
          const y = Math.floor(offset / 4 / canvas.width);
          if (!interior && x > canvas.width * .4 && x < canvas.width * .6 && y > canvas.height * .4 && y < canvas.height * .6)
            interior = { x, y, color: [r, g, b] };
        }
        brightness += .2126 * r + .7152 * g + .0722 * b;
        count++;
      }
      const bounds = canvas.getBoundingClientRect();
      const picked = interior ? renderer.pickTile(
        bounds.x + (interior.x + .5) / canvas.width * bounds.width,
        bounds.y + (canvas.height - interior.y - .5) / canvas.height * bounds.height,
      ) : null;
      results.push({ ...sample, naturalFraction: natural / count, brightness: brightness / count, picked, pickedColor: interior?.color });
    }
    video.pause();
    window.clearInterval(paint);
    stream.getTracks().forEach(track => track.stop());
    video.remove();
    renderer.dispose();
    canvas.remove();
    return results;
  }, { patches, sourceGroups });

  for (const result of results) {
    expect(result.naturalFraction, `${result.mode}, video RGB ${result.color}, contrast ${result.contrast}: interior pixels must retain atlas colors`).toBeGreaterThan(.8);
    expect(result.picked).not.toBeNull();
    const patch = patches.find(patch => patch.index === result.picked.patchIndex)!;
    expect(patch, 'Picking must identify the rendered natural image patch').toBeDefined();
    expect(result.picked.atlasIndex).toBe(patch.sourceIndex);
    expect(sourceGroups[result.mode], 'Drawn imagery must belong to the selected landscape type').toContain(patch.sourceIndex);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(result.pickedColor![channel] - patch.meanRgb[channel]), 'Picked patch metadata must match the actual drawn pixel').toBeLessThanOrEqual(1);
  }
  expect(results[1].brightness - results[0].brightness, 'Bright video frames must select naturally brighter imagery').toBeGreaterThan(100);
  expect(new Set(results.slice(0, 4).map(result => result.picked.patchIndex)).size,
    'Different source colors must choose different satellite patches').toBeGreaterThanOrEqual(3);
  expect(results.some(result => result.picked.atlasIndex > 255), 'Rendering and picking must reach scenes beyond the original small library and the first byte of source IDs').toBe(true);
  expect(results[4].picked.patchIndex, 'Contrast changes which natural patch is selected').not.toBe(results[5].picked.patchIndex);
});
