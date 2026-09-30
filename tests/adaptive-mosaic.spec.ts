import { test, expect } from '@playwright/test';
import { png } from './texture-fixtures';
import { readMosaicAssets } from './mosaic-assertions';

test('matching follows structure, refines detailed regions, and holds good photos through tiny fluctuations', async ({ page }) => {
  const { mosaic } = readMosaicAssets();
  const library = {
    ...mosaic, atlasPages: undefined, detailPages: undefined, detailAtlas: undefined,
    atlas: '/test-matching-atlas.svg',
    layout: { columns: 4, rows: 1, tileSize: 64, width: 256, height: 64 },
    features: { url: '/test-features.png', columns: 4, rows: 1, texelsPerPatch: 2 },
    patches: mosaic.patches.slice(0, 4).map((patch, index) => ({ ...patch, column: index, row: 0 })),
    lookup: { size: 2, variants: 4, urls: { satellite: '/test-lookup.png', terrain: '/test-lookup.png', coasts: '/test-lookup.png' } },
  };
  const descriptors = [
    126,126,126,255, 126,126,126,126,
    130,130,130,255, 130,130,130,130,
    128,128,128,255, 112,144,112,144,
    128,128,128,255, 144,112,144,112,
  ];
  const candidates = Array.from({ length: 8 }, (_, row) => Array.from({ length: 4 }, () => [Math.floor(row / 2),0,0,255]).flat()).flat();
  await page.route('**/satellite-mosaic.json', route => route.fulfill({ json: library }));
  await page.route('**/test-features.png', route => route.fulfill({ contentType: 'image/png', body: png(8, 1, descriptors) }));
  await page.route('**/test-lookup.png', route => route.fulfill({ contentType: 'image/png', body: png(4, 8, candidates) }));
  await page.route('**/test-matching-atlas.svg', route => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="64"><rect width="256" height="64" fill="#808080"/></svg>' }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const url = '/src/satellite-renderer.ts';
    const { SatelliteRenderer } = await import(url);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:624px;height:416px;z-index:9999';
    document.body.append(canvas);
    const renderer = new SatelliteRenderer(canvas);
    await renderer.loadAtlas();
    renderer.setSettings({ density: 24, organic: 0, contrast: 1 });
    const source = document.createElement('canvas');
    source.width = 624; source.height = 416;
    const ctx = source.getContext('2d')!;
    const stream = source.captureStream(30);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    document.body.append(video);
    let paint = () => { ctx.fillStyle = 'rgb(127,127,127)'; ctx.fillRect(0, 0, 624, 416); };
    paint();
    const timer = setInterval(() => paint(), 16);
    await video.play();
    const frame = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic frame did not decode')), 2000);
      video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
    const render = async (draw: () => void, time: number) => {
      paint = draw; paint(); await frame(); paint(); await frame();
      renderer.render(video, time);
    };
    const solid = (value: number) => () => {
      ctx.fillStyle = `rgb(${value},${value},${value})`; ctx.fillRect(0, 0, 624, 416);
    };
    const pick = () => renderer.pickTile(300, 196);
    await render(solid(127), 1);
    const initial = pick();
    await render(solid(129), 1.04);
    const stable = pick();
    await render(solid(129), 3); // Discontinuity: immediately use the new best match.
    const afterSeek = pick();
    await render(solid(126), 3.04); // A meaningful difference also switches without waiting.
    const changed = pick();
    // Target the exact picked coarse cell center. At this density each parent
    // occupies40source pixels; read its jitter from the shared geometry formula.
    const hash = (x: number, y: number) => {
      const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return value - Math.floor(value);
    };
    const centerX = (initial.cellX + .5 + (hash(initial.cellX, initial.cellY) - .5) * .24) * 40;
    const pattern = (reverse: boolean, amplitude: number) => () => {
      const left = 128 + (reverse ? amplitude : -amplitude);
      const right = 256 - left;
      ctx.fillStyle = `rgb(${left},${left},${left})`; ctx.fillRect(0, 0, centerX, 416);
      ctx.fillStyle = `rgb(${right},${right},${right})`; ctx.fillRect(centerX, 0, 624 - centerX, 416);
      ctx.fillStyle = 'rgb(128,128,128)'; ctx.fillRect(Math.floor(centerX) - 1, 0, 3, 416);
    };
    await render(pattern(false, 16), 5);
    const leftDark = pick();
    await render(pattern(true, 16), 7);
    const rightDark = pick();
    const boundaries = () => {
      const cells = [];
      const sizes = [];
      for (let y = 160; y <= 232; y += 12) for (let x = 260; x <= 340; x += 8) {
        const cell = renderer.pickTile(x, y);
        cells.push(`${cell.cellX},${cell.cellY}`);
        sizes.push(cell.cellScale);
      }
      return { cells, sizes };
    };
    const quietBoundaries = boundaries();
    await render(pattern(false, 90), 9);
    const refined = pick();
    const smooth = renderer.pickTile(100, 196);
    const edgeBoundaries = boundaries();
    await render(pattern(false, 90), 9.04);
    const stableBoundaries = boundaries();
    await render(() => {
      solid(128)();
      for (let y = 144; y < 256; y += 8) for (let x = 240; x < 368; x += 8) {
        const value = (x / 8 + y / 8) % 2 ? 38 : 218;
        ctx.fillStyle = `rgb(${value},${value},${value})`;
        ctx.fillRect(x, y, 8, 8);
      }
    }, 11);
    const texturedBoundaries = boundaries();
    const glError = canvas.getContext('webgl')!.getError();
    clearInterval(timer); video.pause(); stream.getTracks().forEach(track => track.stop());
    renderer.dispose(); video.remove(); canvas.remove();
    return { initial, stable, afterSeek, changed, leftDark, rightDark, refined, smooth, glError,
      quietBoundaries, edgeBoundaries, stableBoundaries, texturedBoundaries };
  });
  expect(result.glError).toBe(0);
  expect(result.initial.patchIndex).toBe(0);
  expect(result.stable.patchIndex, 'Tiny frame changes should retain a still-good image').toBe(0);
  expect(result.afterSeek.patchIndex, 'A seek/stall discards stale matching history').toBe(1);
  expect(result.changed.patchIndex, 'A meaningfully better match should replace the photo immediately').toBe(0);
  expect(result.leftDark.patchIndex, 'Equal-mean candidates should follow left/right source structure').toBe(2);
  expect(result.rightDark.patchIndex).toBe(3);
  expect(result.leftDark.cellScale).toBe(1);
  expect(result.texturedBoundaries.sizes, 'Textured detail needs smaller cells even with movable parent boundaries').toContain(.5);
  expect(result.smooth.cellScale, 'An adjacent smooth region should keep a larger clear image').toBe(1);
  expect(result.edgeBoundaries.cells.filter((cell, index) => cell !== result.quietBoundaries.cells[index]).length,
    'Parent boundaries must move and reshape with strong edges, not only split inside a fixed outline').toBeGreaterThan(3);
  expect(result.stableBoundaries, 'An unchanged frame must hold exactly the same boundary geometry').toEqual(result.edgeBoundaries);
});

test('the limited-precision shader path renders varied scenes and preserves tile picking', async ({ page }) => {
  await page.addInitScript(() => {
    const original = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
    WebGLRenderingContext.prototype.getShaderPrecisionFormat = function (shader, precision) {
      if (shader === this.FRAGMENT_SHADER && precision === this.HIGH_FLOAT) return null;
      return original.call(this, shader, precision);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const selections = await page.evaluate(async () => {
    const url = '/src/satellite-renderer.ts';
    const { SatelliteRenderer } = await import(url);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px';
    document.body.append(canvas);
    const renderer = new SatelliteRenderer(canvas);
    await renderer.loadAtlas();
    const selections = [];
    for (let y = 40; y < 400; y += 80) for (let x = 40; x < 600; x += 80)
      selections.push(renderer.pickTile(x, y));
    const error = canvas.getContext('webgl')!.getError();
    renderer.dispose(); canvas.remove();
    return { selections, error };
  });
  expect(errors).toEqual([]);
  expect(selections.error).toBe(0);
  expect(selections.selections.every(selection => selection && selection.patchIndex >= 0)).toBe(true);
  expect(new Set(selections.selections.map(selection => selection.patchIndex)).size).toBeGreaterThan(10);
});
