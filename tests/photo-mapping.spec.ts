import { test, expect } from '@playwright/test';
import { png } from './texture-fixtures';
import { readMosaicAssets } from './mosaic-assertions';


for (const streamed of [false, true]) test(`zoomed photographs stay upright, proportional, and free of smeared edges (${streamed ? 'streamed detail' : 'base imagery'})`, async ({ page }) => {
  if (streamed) await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { value: 8 }));
  // R encodes original image x, G encodes original image y. Any rotation,
  // stretching, nonlinear warp, reflection, or repeated edge pixels is directly
  // observable in the rendered colors, independently of the bounds algorithm.
  const pixels = [];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++)
    pixels.push(Math.round(16 + x / 127 * 224), Math.round(16 + y / 127 * 224), 128, 255);
  const manifest = {
    collectionId: readMosaicAssets().mosaic.collectionId,
    detailAtlas: streamed ? { url: '/photo-detail-gradient.png', tileSize: 128, width: 128, height: 128 } : undefined,
    atlas: '/photo-gradient.png', sourceManifest: '/satellite-scenes.json',
    layout: { columns: 1, rows: 1, tileSize: 128, width: 128, height: 128 },
    features: { url: '/photo-features.png', columns: 1, rows: 1, texelsPerPatch: 2 },
    patches: [{ index: 0, sourceIndex: 0, column: 0, row: 0, meanRgb: [128,128,128], cropPixels: [0,0,128,128], previewUrl: streamed ? '/photo-detail-gradient.png' : '/photo-gradient.png', previewWidth: 128, previewHeight: 128 }],
    lookup: { size: 1, variants: 1, urls: { satellite: '/photo-lookup.png', terrain: '/photo-lookup.png', coasts: '/photo-lookup.png' } },
  };
  await page.route('**/satellite-mosaic.json', route => route.fulfill({ json: manifest }));
  await page.route('**/photo-gradient.png', route => route.fulfill({ contentType: 'image/png', body: png(128,128,streamed ? Array.from({ length: 128*128 }, () => [128,128,128,255]).flat() : pixels) }));
  await page.route('**/photo-detail-gradient.png', route => route.fulfill({ contentType: 'image/png', body: png(128,128,pixels) }));
  await page.route('**/photo-features.png', route => route.fulfill({ contentType: 'image/png', body: png(2,1,[128,128,128,255,72,96,160,184]) }));
  await page.route('**/photo-lookup.png', route => route.fulfill({ contentType: 'image/png', body: png(1,1,[0,0,0,255]) }));
  await page.goto('/');
  const scenarios = await page.evaluate(async streamed => {
    const url = '/src/satellite-renderer.ts';
    const { SatelliteRenderer } = await import(url);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px';
    document.body.append(canvas);
    const renderer = new SatelliteRenderer(canvas);
    await renderer.loadAtlas();
    const source = document.createElement('canvas'); source.width = 640; source.height = 480;
    const ctx = source.getContext('2d')!;
    const paint = () => {
      ctx.fillStyle = '#777'; ctx.fillRect(0,0,640,480);
      for (let y = 0; y < 480; y += 21) for (let x = 260; x < 640; x += 21) {
        ctx.fillStyle = (Math.floor(x/21) + Math.floor(y/21)) % 2 ? '#e8bf78' : '#122c44';
        ctx.fillRect(x,y,21,21);
      }
    };
    paint();
    const stream = source.captureStream(30);
    const video = document.createElement('video'); video.muted = true; video.playsInline = true;
    video.srcObject = stream; document.body.append(video);
    const timer = setInterval(paint,16); await video.play();
    await new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()));
    const results = [];
    for (const organic of [0,1]) {
      renderer.setSettings({ density: 24, organic, contrast: 1 });
      renderer.setView({ zoom: 4, x: .06, y: 0 });
      renderer.clearSelection(); renderer.render(video, video.currentTime);
      if (streamed) await new Promise<void>((resolve,reject) => {
        const start = performance.now();
        const check = () => {
          if (canvas.dataset.detailQuality === 'ready') resolve();
          else if (performance.now()-start > 5000) reject(new Error('Streamed detail did not finish'));
          else requestAnimationFrame(check);
        };
        check();
      });
      renderer.render(video, video.currentTime);
      const gl = canvas.getContext('webgl')!;
      const width = canvas.width, height = canvas.height;
      const pixels = new Uint8Array(width*height*4);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const bounds = canvas.getBoundingClientRect();
      const color = (x: number,y: number) => Array.from(pixels.subarray((y*width+x)*4,(y*width+x)*4+3));
      const key = (x: number,y: number) => {
        const cell = renderer.pickTile(bounds.x+(x+.5)/width*bounds.width,bounds.y+(height-y-.5)/height*bounds.height);
        return cell ? `${cell.cellX},${cell.cellY},${cell.subCell}` : 'missing';
      };
      const measures = [];
      let covered = 0, interiors = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i+2] >= 126) {
        interiors++; if (pixels[i]>=16 && pixels[i]<=240 && pixels[i+1]>=16 && pixels[i+1]<=240) covered++;
      }
      const step = 6;
      for (let y = 24; y < height-24; y += 31) for (let x = 24; x < width-24; x += 37) {
        if (measures.length >= 64) break;
        const samples = [[x-step,y],[x+step,y],[x,y-step],[x,y+step]];
        const colors = samples.map(([x,y]) => color(x,y));
        if (colors.some(c => c[2]<127)) continue; // Ignore neutral mask seams.
        const keys = samples.map(([x,y]) => key(x,y));
        if (new Set(keys).size !== 1 || keys[0]==='missing') continue;
        const [left,right,bottom,top] = colors;
        measures.push({ dxR:right[0]-left[0], dxG:right[1]-left[1], dyR:top[0]-bottom[0], dyG:bottom[1]-top[1] });
      }
      results.push({organic,measures,coverage:covered/interiors,error:gl.getError()});
    }
    clearInterval(timer); video.pause(); stream.getTracks().forEach(track=>track.stop());
    renderer.dispose(); video.remove(); canvas.remove();
    return results;
  }, streamed);
  for (const scenario of scenarios) {
    expect(scenario.error).toBe(0);
    expect(scenario.coverage,'Every interior pixel must lie inside its photograph').toBeGreaterThan(.999);
    expect(scenario.measures.length,'Exercise a broad set of tile interiors').toBeGreaterThan(40);
    for (const sample of scenario.measures) {
      expect(Math.abs(sample.dxG),'Horizontal photo lines must not bend or rotate').toBeLessThanOrEqual(2);
      expect(Math.abs(sample.dyR),'Vertical photo lines must not bend or rotate').toBeLessThanOrEqual(2);
      expect(sample.dxR,'Photo columns must advance instead of clamping into a streak').toBeGreaterThan(2);
      expect(sample.dyG,'Photo rows must advance instead of clamping into a streak').toBeGreaterThan(2);
      expect(Math.abs(sample.dxR-sample.dyG),'Preserve equal scale in both image directions').toBeLessThanOrEqual(2);
    }
  }
});
