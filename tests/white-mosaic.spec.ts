import { test, expect } from '@playwright/test';
import { readMosaicAssets } from './mosaic-assertions';

const luminance = (rgb: number[]) => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
const channelSpread = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb);

test('the production palette contains enough naturally bright neutral photographs for white ice', () => {
  const { mosaic } = readMosaicAssets();
  const brightNeutral = mosaic.patches.filter(patch =>
    luminance(patch.meanRgb) >= 200 && channelSpread(patch.meanRgb) <= 25,
  );
  expect(brightNeutral.length, 'White video needs real bright neutral imagery, not a yellow desert substitute')
    .toBeGreaterThanOrEqual(8);
});

test('white and cool ice choose neutral satellite photos while yellow video retains naturally warm imagery', async ({ page }) => {
  const { mosaic, sources } = readMosaicAssets();
  // Use the delivered photographs, descriptors, and lookup tables unchanged.
  // The synthetic video isolates the white-ice regression from codec/file noise.
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const moduleURL = '/src/satellite-renderer.ts';
    const { SatelliteRenderer } = await import(moduleURL);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;z-index:9999';
    document.body.append(canvas);
    const renderer = new SatelliteRenderer(canvas);
    await renderer.loadAtlas();
    renderer.resize();
    renderer.setImageryMode('satellite');

    const source = document.createElement('canvas');
    source.width = 192;
    source.height = 108;
    const context = source.getContext('2d')!;
    context.fillRect(0, 0, source.width, source.height);
    const stream = source.captureStream(30);
    const video = document.createElement('video');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0';
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.append(video);
    const paint = window.setInterval(() => context.fillRect(0, 0, source.width, source.height), 16);
    const frame = () => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('The synthetic ice video did not decode a frame.')), 2000);
      video.requestVideoFrameCallback(() => { window.clearTimeout(timeout); resolve(); });
    });
    const decoded = document.createElement('canvas');
    decoded.width = decoded.height = 1;
    const decoder = decoded.getContext('2d')!;
    const gl = canvas.getContext('webgl')!;
    const results = [];

    try {
      await video.play();
      for (const target of [[240, 240, 240], [220, 225, 230], [240, 210, 140]]) {
        context.fillStyle = `rgb(${target.join(',')})`;
        context.fillRect(0, 0, source.width, source.height);
        await frame();
        context.fillRect(0, 0, source.width, source.height);
        await frame();
        decoder.drawImage(video, 0, 0, 1, 1);
        const decodedRgb = Array.from(decoder.getImageData(0, 0, 1, 1).data.slice(0, 3));
        renderer.setSettings({ density: 60, organic: .7, contrast: 1 });
        renderer.render(video, video.currentTime);
        // Read in the rendering task: preserveDrawingBuffer is deliberately off.
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const mean = [0, 0, 0];
        let count = 0;
        for (let y = 4; y < canvas.height - 4; y += 3) {
          for (let x = 4; x < canvas.width - 4; x += 3) {
            const offset = (y * canvas.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) mean[channel] += pixels[offset + channel];
            count++;
          }
        }
        const bounds = canvas.getBoundingClientRect();
        const picks = [];
        for (const y of [.25, .5, .75]) for (const x of [.25, .5, .75])
          picks.push(renderer.pickTile(bounds.left + bounds.width * x, bounds.top + bounds.height * y));
        results.push({ target, decodedRgb, mean: mean.map(value => value / count), picks });
      }
    } finally {
      video.pause();
      window.clearInterval(paint);
      stream.getTracks().forEach(track => track.stop());
      video.remove();
      renderer.dispose();
      canvas.remove();
    }
    return results;
  });

  const sourceById = new Map(sources.map(source => [source.index, source]));
  for (const [index, result] of results.entries()) {
    const isIce = index < 2;
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(result.decodedRgb[channel] - result.target[channel]), 'Verify the intended video frame reached the decoder')
        .toBeLessThanOrEqual(5);
    const selectedMeans: number[][] = [];
    for (const pick of result.picks) {
      expect(pick, 'Picking must resolve the photo actually displayed by the production renderer').not.toBeNull();
      const patch = mosaic.patches.find(candidate => candidate.index === pick.patchIndex)!;
      expect(patch).toBeDefined();
      expect(pick.atlasIndex).toBe(patch.sourceIndex);
      expect(sourceById.get(patch.sourceIndex)?.imageryModes).toContain('satellite');
      selectedMeans.push(patch.meanRgb);
      if (isIce) {
        expect(luminance(patch.meanRgb), `RGB ${result.target}: the selected photo must itself be bright`).toBeGreaterThanOrEqual(200);
        expect(channelSpread(patch.meanRgb), `RGB ${result.target}: the selected photo must itself be neutral`).toBeLessThanOrEqual(25);
      } else {
        expect(patch.meanRgb[0] - patch.meanRgb[2], 'Warm input must still choose real warm photographs').toBeGreaterThan(40);
      }
    }
    const selectedMean = [0, 1, 2].map(channel => selectedMeans.reduce((sum, rgb) => sum + rgb[channel], 0) / selectedMeans.length);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(result.mean[channel] - selectedMean[channel]), 'Actual atlas pixels must agree with the chosen photographs in aggregate')
        .toBeLessThan(20);
    if (isIce) {
      expect(luminance(result.mean), 'White ice must remain bright in the actual framebuffer').toBeGreaterThan(190);
      expect(channelSpread(result.mean), 'White ice must not acquire a desert-yellow cast').toBeLessThan(30);
    } else {
      expect(result.mean[0] - result.mean[2], 'The fix must preserve warm natural imagery instead of desaturating the output')
        .toBeGreaterThan(40);
    }
  }
});
