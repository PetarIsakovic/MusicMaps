import type { SatelliteSource } from './tile-details';
import { IMAGERY_COLLECTION, type MapPhotoTile } from './imagery-collection';

export type SceneLocation = {
  center: [number, number]; // latitude, longitude (map / Google Maps order)
  bounds: [number, number, number, number]; // west, south, east, north
  footprint: [number, number][]; // latitude, longitude
  pointAt: (x: number, y: number) => [number, number];
};
const pending = new Map<string, Promise<SceneLocation>>();

/** Exact inverse of the map's Web Mercator pixel grid, including dateline wrap. */
export function mapPhotoLocation(tile: MapPhotoTile): SceneLocation {
  const { x, y, z, tileSize } = tile;
  if (tile.collectionId !== IMAGERY_COLLECTION.id || !Number.isInteger(z) || z < 0 || z > 22
    || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
    || tileSize !== IMAGERY_COLLECTION.tileSize) throw new Error('Invalid map photograph coordinates');
  const point = (px: number, py: number): [number, number] => [
    Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / tileSize) / 2 ** z))) * 180 / Math.PI,
    (x + px / tileSize) / 2 ** z * 360 - 180,
  ];
  const nw = point(0, 0);
  const se = point(tileSize, tileSize);
  return {
    center: point(tileSize / 2, tileSize / 2),
    bounds: [nw[1], se[0], se[1], nw[0]],
    footprint: [nw, point(tileSize, 0), se, point(0, tileSize)],
    pointAt: (px, py) => {
      const [lat, lng] = point(Math.max(0, Math.min(tileSize, px)), Math.max(0, Math.min(tileSize, py)));
      return [lat, ((lng + 180) % 360 + 360) % 360 - 180];
    },
  };
}

/** Map photos locate locally; legacy acquisitions share a cached STAC request. */
export function locateScene(source: SatelliteSource): Promise<SceneLocation> {
  if (source.mapTile) {
    try { return Promise.resolve(mapPhotoLocation(source.mapTile)); }
    catch (error) { return Promise.reject(error); }
  }
  const key = `${source.itemId}:${source.cropPixels?.join(',')}:${source.thumbnailDimensions?.join(',')}`;
  const cached = pending.get(key);
  if (cached) return cached;
  const request = (async () => {
    if (!source.stacItemUrl) throw new Error('Scene coordinates are unavailable');
    const [{ readSceneGrid, photoProjection }, response] = await Promise.all([
      import('./scene-georeference'),
      fetch(source.stacItemUrl, { signal: AbortSignal.timeout(12_000) }),
    ]);
    if (!response.ok) throw new Error('Scene coordinates could not load');
    if (!source.cropPixels || !source.thumbnailDimensions) throw new Error('Photograph crop is unavailable');
    const projection = photoProjection(readSceneGrid(await response.json(), source.itemId), {
      cropPixels: source.cropPixels, thumbnailDimensions: source.thumbnailDimensions,
    });
    const pointAt = (x: number, y: number): [number, number] => {
      const [longitude, latitude] = projection.geographic(x, y);
      // Normalize only after calculating the continuous footprint across 180°.
      return [latitude, ((longitude + 180) % 360 + 360) % 360 - 180];
    };
    return {
      center: pointAt(projection.cropWidth / 2, projection.cropHeight / 2),
      bounds: projection.bounds,
      footprint: projection.footprint.map(([lng, lat]) => [lat, lng] as [number, number]),
      pointAt,
    };
  })();
  pending.set(key, request);
  request.catch(() => { if (pending.get(key) === request) pending.delete(key); });
  if (pending.size > 128) pending.delete(pending.keys().next().value!);
  return request;
}

export function coordinateText([latitude, longitude]: [number, number]): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
