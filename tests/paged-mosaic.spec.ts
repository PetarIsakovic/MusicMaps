import { test, expect } from '@playwright/test';
import { png } from './texture-fixtures';
import { readMosaicAssets } from './mosaic-assertions';

for (const limitedPrecision of [false, true]) {
  test(`four atlas pages and dense-cell picking agree with displayed pixels (${limitedPrecision ? 'fallback' : 'high'} precision)`, async ({ page }) => {
    await page.addInitScript(() => {
      const activeTexture = WebGLRenderingContext.prototype.activeTexture;
      WebGLRenderingContext.prototype.activeTexture = function(unit) {
        if (unit >= this.TEXTURE0 + 8) throw new Error('Exceeded the eight texture-unit budget');
        return activeTexture.call(this, unit);
      };
    });
    if (limitedPrecision) await page.addInitScript(() => {
      const original = WebGLRenderingContext.prototype.getShaderPrecisionFormat;
      WebGLRenderingContext.prototype.getShaderPrecisionFormat = function(shader, precision) {
        return shader === this.FRAGMENT_SHADER && precision === this.HIGH_FLOAT ? null : original.call(this, shader, precision);
      };
    });
    // A different natural test color per texture page makes wrong-page sampling
    // observable. Source IDs span both byte boundaries; cells span address 65536.
    const colors = [[200,40,40], [40,200,40], [40,40,200], [220,220,220]];
    const pages = colors.map((_, index) => ({ url: `/test-page-${index}.png`, columns: 64, rows: 64, tileSize: 1, width: 64, height: 64 }));
    const features: number[] = [];
    const patches = Array.from({ length: 16384 }, (_, index) => {
      const rgb = colors[Math.floor(index / 4096)];
      const luminance = Math.round(rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722);
      features.push(...rgb, 0, luminance, luminance, luminance, luminance);
      return { index, sourceIndex: index, column: index % 64, row: Math.floor(index / 64), meanRgb: rgb, cropPixels: [0,0,64,64], previewUrl: '/test-native-photo.png', previewWidth: 256 };
    });
    const lookup = Array.from({ length: 64 }, (_, index) => {
      const group = Math.floor(index / 8);
      const id = [0,1,4096,4097,8192,8193,16382,16383][group];
      return [id % 256, Math.floor(id / 256), 0, 255];
    }).flat();
    await page.route('**/satellite-mosaic.json', route => route.fulfill({ json: {
      collectionId: readMosaicAssets().mosaic.collectionId,
      atlas: pages[0].url, atlasPages: pages, detailAtlas: pages[0], sourceManifest: '/satellite-scenes.json',
      layout: { columns: 64, rows: 256, tileSize: 1, width: 64, height: 256 }, patches,
      features: { url: '/test-page-features.png', columns: 64, rows: 256, texelsPerPatch: 2 },
      lookup: { size: 2, variants: 8, urls: { satellite: '/test-page-lookup.png', terrain: '/test-page-lookup.png', coasts: '/test-page-lookup.png' } },
    } }));
    for (let i = 0; i < pages.length; i++) await page.route(`**${pages[i].url}`, route => route.fulfill({ contentType: 'image/png', body: png(64,64,Array.from({length:4096}, () => [...colors[i],255]).flat()) }));
    await page.route('**/test-page-features.png', route => route.fulfill({ contentType: 'image/png', body: png(128,256,features) }));
    await page.route('**/test-page-lookup.png', route => route.fulfill({ contentType: 'image/png', body: png(4,16,lookup) }));
    await page.route('**/test-native-photo.png', route => route.fulfill({ contentType: 'image/png', body: png(256,256,Array.from({length:65536}, () => [240,150,20,255]).flat()) }));
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const url = '/src/satellite-renderer.ts';
      const { SatelliteRenderer } = await import(url);
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:624px;height:624px';
      document.body.append(canvas);
      const renderer = new SatelliteRenderer(canvas); await renderer.loadAtlas();
      const counts = [];
      const sampled = [];
      const gl = canvas.getContext('webgl')!;
      for (const density of [24,260]) {
        renderer.setSettings({ density, organic: .7, contrast: 1 });
        renderer.clearSelection(); renderer.renderIdle();
        const pixels = new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const keys = new Set();
        for (let y = 530; y < 594; y += 8) for (let x = 530; x < 594; x += 8) {
          const pick = renderer.pickTile(x+.5,624-y-.5);
          keys.add(`${pick.cellX},${pick.cellY},${pick.subCell}`);
          if (density === 260) {
            const pixelX = Math.floor((x+.5)/624*canvas.width);
            const pixelY = canvas.height-1-Math.floor((624-y-.5)/624*canvas.height);
            const offset = (pixelY*canvas.width+pixelX)*4;
            sampled.push({ pick, color: Array.from(pixels.subarray(offset,offset+3)) });
          }
        }
        counts.push(keys.size);
      }
      const corner = renderer.pickTile(614,10);
      // A conspicuous native-resolution marker must only replace its own photo.
      // Another photo on the same atlas page must keep its original pixels.
      renderer.setSettings({ density: 90, organic: .7, contrast: 1 });
      renderer.setView({ zoom: 2, x: 0, y: 0 });
      const focus = renderer.pickTile(312,312).patchIndex;
      const deadline = performance.now() + 5000;
      while (canvas.dataset.detailQuality !== 'ready' && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 30));
      const detailQuality = canvas.dataset.detailQuality;
      renderer.clearSelection(); renderer.renderIdle();
      const pixels = new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const detailSamples = [];
      for (let y = 32; y < 600; y += 48) for (let x = 32; x < 600; x += 48) {
        const pick = renderer.pickTile(x+.5,y+.5);
        const px = Math.floor((x+.5)/624*canvas.width);
        const py = canvas.height-1-Math.floor((y+.5)/624*canvas.height);
        const offset = (py*canvas.width+px)*4;
        detailSamples.push({ id: pick.patchIndex, color: Array.from(pixels.subarray(offset,offset+3)) });
      }
      const error = gl.getError(); renderer.dispose(); canvas.remove();
      return { counts, sampled, corner, error, detailQuality, focus, detailSamples };
    });
    expect(result.error).toBe(0);
    expect(result.counts[1]).toBeGreaterThan(result.counts[0]*4);
    expect(result.corner.cellX).toBeGreaterThan(160);
    expect(result.corner.cellY).toBeGreaterThan(160);
    const usedPages = new Set<number>();
    let matching = 0;
    for (const sample of result.sampled) {
      expect([0,1,4096,4097,8192,8193,16382,16383]).toContain(sample.pick.patchIndex);
      expect(sample.pick.atlasIndex).toBe(sample.pick.patchIndex);
      const pageIndex = Math.floor(sample.pick.patchIndex / 4096);
      usedPages.add(pageIndex);
      if (sample.color.every((value, channel) => Math.abs(value-colors[pageIndex][channel]) <= 1)) matching++;
    }
    expect([...usedPages].sort()).toEqual([0,1,2,3]);
    // Unselected masks meet without artificial dark lines, including bright pages.
    expect(matching).toBe(result.sampled.length);
    expect(result.detailQuality).toBe('ready');
    let samePageNeighbor = 0;
    let detailed = 0;
    for (const sample of result.detailSamples) {
      const expected = sample.id === result.focus ? [240,150,20] : colors[Math.floor(sample.id/4096)];
      if (sample.id === result.focus) detailed++;
      else if (Math.floor(sample.id/4096) === Math.floor(result.focus/4096)) samePageNeighbor++;
      expect(sample.color.every((value, channel) => Math.abs(value-expected[channel]) <= 1),
        `Photo ${sample.id} while photo ${result.focus} has native detail`).toBe(true);
    }
    expect(detailed).toBeGreaterThan(0);
    expect(samePageNeighbor).toBeGreaterThan(0);
  });
}
