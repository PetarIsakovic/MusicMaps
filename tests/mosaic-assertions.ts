import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export type MosaicMode = 'coasts' | 'terrain' | 'satellite';

export type MosaicScene = {
  index: number;
  region: string;
  acquiredAt?: string;
  mapTile: { collectionId: string; z: number; x: number; y: number; tileSize: number };
  pixelSha256: string;
  itemId: string;
  gridCode?: string;
  imageryModes: MosaicMode[];
  sceneBoundingBox: [number, number, number, number];
  thumbnailDimensions: [number, number];
  cropPixels: [number, number, number, number];
  thumbnailUrl: string;
  thumbnailSha256: string;
  provenance: { layer: string; mosaicPeriod: string };
  quality: { version: number; accepted: boolean; reasons: string[] };
};

export type MosaicAtlasPage = {
  url: string; columns: number; rows: number; tileSize: number; width: number; height: number;
};

export type MosaicManifest = {
  collectionId: string;
  atlas: string;
  atlasPages?: MosaicAtlasPage[];
  detailPages?: MosaicAtlasPage[];
  detailAtlas?: { url: string; tileSize: number; width: number; height: number };
  sourceManifest: string;
  features: { url: string; columns: number; rows: number };
  layout: { columns: number; rows: number; tileSize: number; width: number; height: number };
  patches: {
    index: number; sourceIndex: number; column: number; row: number;
    meanRgb: [number, number, number]; cropPixels: [number, number, number, number];
    previewUrl: string; previewWidth: number; previewHeight: number;
  }[];
};

export function mosaicAtlasPages(mosaic: MosaicManifest): MosaicAtlasPage[] {
  return mosaic.atlasPages ?? [{ url: mosaic.atlas, ...mosaic.layout }];
}

export function mosaicDetailPages(mosaic: MosaicManifest): MosaicAtlasPage[] {
  return mosaic.detailPages ?? (mosaic.detailAtlas ? [{ ...mosaic.layout, ...mosaic.detailAtlas }] : []);
}

/** Resolve the expected photograph without reusing the app's page calculation. */
export function mosaicPageForPatch(mosaic: MosaicManifest, patch: MosaicManifest['patches'][number]) {
  let startRow = 0;
  for (const page of mosaicAtlasPages(mosaic)) {
    if (patch.row >= startRow && patch.row < startRow + page.rows) return { ...page, row: patch.row - startRow, column: patch.column };
    startRow += page.rows;
  }
  throw new Error(`Patch ${patch.index} has no atlas page`);
}

export function readMosaicAssets() {
  const mosaic = JSON.parse(readFileSync('public/satellite-mosaic.json', 'utf8')) as MosaicManifest;
  const { sources } = JSON.parse(readFileSync(`public${mosaic.sourceManifest}`, 'utf8')) as { sources: MosaicScene[] };
  return { mosaic, sources };
}

/** Check the enlarged crop against the actual patch picked by the GPU. */
export async function expectMosaicPreview(page: Page, sourceIndex: number) {
  const { mosaic } = readMosaicAssets();
  const preview = page.locator('#tile-preview');
  await expect(preview).toHaveAttribute('data-patch-index', /^\d+$/);
  const patchIndex = Number(await preview.getAttribute('data-patch-index'));
  const patch = mosaic.patches.find(candidate => candidate.index === patchIndex);
  expect(patch, 'The enlarged image must identify a real mosaic patch').toBeDefined();
  expect(patch!.sourceIndex, 'The crop and source metadata must describe the same scene').toBe(sourceIndex);
  const atlas = mosaicPageForPatch(mosaic, patch!);
  const style = await preview.evaluate(element => {
    const computed = getComputedStyle(element);
    return { image: computed.backgroundImage, size: computed.backgroundSize,
      x: parseFloat(computed.backgroundPositionX), y: parseFloat(computed.backgroundPositionY) };
  });
  expect(style.image).toContain(atlas.url);
  expect(parseFloat(style.size)).toBe(atlas.columns * 100);
  expect(style.x).toBeCloseTo(atlas.column / Math.max(1, atlas.columns - 1) * 100, 2);
  expect(style.y).toBeCloseTo(atlas.row / Math.max(1, atlas.rows - 1) * 100, 2);
  return patchIndex;
}
