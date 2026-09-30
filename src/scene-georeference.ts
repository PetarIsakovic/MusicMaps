import proj4 from 'proj4';

export type SceneGrid = {
  epsg: number;
  shape: [number, number];
  transform: [number, number, number, number, number, number];
};
export type PhotoGrid = {
  thumbnailDimensions: [number, number];
  cropPixels: [number, number, number, number];
};
export type GeographicBounds = [number, number, number, number];

/** STAC transforms refer to pixel edges in the native CRS, not the item bbox. */
export function readSceneGrid(item: any, expectedId: string): SceneGrid {
  if (item?.id !== expectedId) throw new Error('Scene metadata does not match the photograph');
  const asset = item.assets?.visual;
  const properties = item.properties;
  const epsg = Number(asset?.['proj:epsg'] ?? properties?.['proj:epsg']
    ?? String(asset?.['proj:code'] ?? properties?.['proj:code'] ?? '').replace('EPSG:', ''));
  const shape = asset?.['proj:shape'] ?? properties?.['proj:shape'];
  const transform = asset?.['proj:transform'] ?? properties?.['proj:transform'];
  // This library contains WGS84 UTM Sentinel-2 scenes. Do not guess a CRS or
  // silently substitute the valid-data bounding box when metadata is missing.
  if (!Number.isInteger(epsg) || !((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760))
    || !Array.isArray(shape) || shape.length !== 2 || !shape.every(n => Number.isInteger(n) && n > 0)
    || !Array.isArray(transform) || transform.length < 6 || !transform.every(Number.isFinite)) {
    throw new Error('Scene projection is unavailable');
  }
  const [a, b, , d, e] = transform;
  if (Math.abs(a * e - b * d) < 1e-10) throw new Error('Scene projection is invalid');
  return { epsg, shape: [...shape] as SceneGrid['shape'], transform: transform.slice(0, 6) as SceneGrid['transform'] };
}

/** Pixel coordinates here are relative to the *cropped* local photograph. */
export function photoProjection(grid: SceneGrid, photo: PhotoGrid) {
  const [width, height] = photo.thumbnailDimensions ?? [];
  const [left, top, right, bottom] = photo.cropPixels ?? [];
  if (![width, height, left, top, right, bottom].every(Number.isFinite)
    || width <= 0 || height <= 0 || left < 0 || top < 0 || right > width || bottom > height
    || right <= left || bottom <= top) throw new Error('Photograph crop coordinates are unavailable');
  const [a, b, c, d, e, f] = grid.transform;
  const scaleX = grid.shape[1] / width;
  const scaleY = grid.shape[0] / height;
  const utm = proj4(`EPSG:${grid.epsg}`, 'EPSG:4326');
  const centralLongitude = (grid.epsg % 100) * 6 - 183;

  function geographic(x: number, y: number): [number, number] {
    const column = (left + x) * scaleX;
    const row = (top + y) * scaleY;
    const [longitude, latitude] = utm.forward([a * column + b * row + c, d * column + e * row + f]);
    // Keep dateline scenes in one world copy when fitting the map camera.
    const unwrapped = longitude + Math.round((centralLongitude - longitude) / 360) * 360;
    return [unwrapped, latitude];
  }
  const footprint: [number, number][] = [];
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  // Project edges too: latitude/longitude extrema need not be at UTM corners.
  for (let side = 0; side < 4; side++) for (let step = 0; step <= 32; step++) {
    const t = step / 32;
    const x = side === 0 ? t * cropWidth : side === 1 ? cropWidth : side === 2 ? (1 - t) * cropWidth : 0;
    const y = side === 0 ? 0 : side === 1 ? t * cropHeight : side === 2 ? cropHeight : (1 - t) * cropHeight;
    footprint.push(geographic(x, y));
  }
  const bounds: GeographicBounds = [Math.min(...footprint.map(p => p[0])), Math.min(...footprint.map(p => p[1])),
    Math.max(...footprint.map(p => p[0])), Math.max(...footprint.map(p => p[1]))];
  return { geographic, bounds, footprint, cropWidth, cropHeight };
}
