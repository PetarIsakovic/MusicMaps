import collection from '../public/imagery-collection.json';

/** The builder writes this same collection ID into every photograph record. */
export const IMAGERY_COLLECTION = collection;
export type MapPhotoTile = {
  collectionId: string;
  z: number;
  x: number;
  y: number;
  tileSize: number;
};

const cachedBlocks = new Set(collection.cachedBlocks.map(([x, y]) => `${x}/${y}`));

export function mapTileUrl({ x, y, z }: { x: number; y: number; z: number }): string {
  const wrappedX = ((x % 2 ** z) + 2 ** z) % 2 ** z;
  const size = collection.cachedBlockSize;
  const cached = z === collection.cachedZoom && cachedBlocks.has(
    `${Math.floor(wrappedX / size) * size}/${Math.floor(y / size) * size}`,
  );
  return (cached ? collection.localTileUrl : collection.remoteTileUrl)
    .replace('{z}', String(z)).replace('{x}', String(wrappedX)).replace('{y}', String(y));
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

// Keep the provider's full credit intact when the collection changes. Both the
// interactive map and video footer use this same manifest-derived attribution.
const attribution = collection.attribution.split(/(https?:\/\/[^\s]+)/g).map(part =>
  /^https?:\/\//.test(part)
    ? `<a href="${escapeHTML(part)}" target="_blank" rel="noopener noreferrer">${escapeHTML(part)}</a>`
    : escapeHTML(part),
).join('');
const licenseLabel = (collection as { licenseLabel?: string }).licenseLabel
  ?? (collection.licenseUrl.match(/creativecommons\.org\/licenses\/([^/]+)\/([^/]+)\//)
    ?.slice(1).map((part, index) => index === 0 ? `CC ${part.toUpperCase()}` : part).join(' ') || 'Image license');

export const MAP_ATTRIBUTION = `${attribution} · `
  + `<a href="${escapeHTML(collection.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(licenseLabel)}</a>`;
