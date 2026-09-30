import type { ImageryMode } from './imagery-modes';
import { IMAGERY_COLLECTION } from './imagery-collection';

export type MosaicPatch = {
  index: number;
  sourceIndex: number;
  column: number;
  row: number;
  meanRgb: [number, number, number];
  cropPixels: [number, number, number, number];
  previewUrl?: string;
  previewWidth?: number;
  previewHeight?: number;
};

export type AtlasPage = {
  url: string;
  columns: number;
  rows: number;
  tileSize: number;
  width: number;
  height: number;
};

export type MosaicLibrary = {
  collectionId: string;
  atlas: string;
  atlasPages?: AtlasPage[];
  detailPages?: AtlasPage[];
  sourceManifest: string;
  features: { url: string; columns: number; rows: number; texelsPerPatch: number };
  detailAtlas?: { url: string; tileSize: number; width: number; height: number };
  layout: { columns: number; rows: number; tileSize: number; width: number; height: number };
  patches: MosaicPatch[];
  lookup: { size: number; variants?: number; urls: Record<ImageryMode, string> };
};

export function atlasPages(library: MosaicLibrary): AtlasPage[] {
  return library.atlasPages ?? [{ url: library.atlas, ...library.layout }];
}

/** Resolve a global image ID to its actual texture page and local image slot. */
export function atlasForPatch(library: MosaicLibrary, patch: MosaicPatch) {
  const pages = atlasPages(library);
  const pageIndex = Math.floor(patch.row / pages[0].rows);
  const page = pages[pageIndex];
  return { ...page, pageIndex, column: patch.column, row: patch.row - pageIndex * pages[0].rows };
}

let libraryRequest: Promise<MosaicLibrary> | undefined;

/** Shared metadata for matching and the exact crop shown in tile details. */
export function loadMosaicLibrary(): Promise<MosaicLibrary> {
  return libraryRequest ??= fetch('/satellite-mosaic.json').then(async response => {
    if (!response.ok) throw new Error('The satellite image library could not load.');
    const library = await response.json() as MosaicLibrary;
    if (library.collectionId !== IMAGERY_COLLECTION.id)
      throw new Error('The satellite library and map must use the same imagery collection. Refresh to load the updated library.');
    return library;
  }).catch(error => {
    libraryRequest = undefined;
    throw error;
  });
}
