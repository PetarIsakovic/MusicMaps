import { icon } from './map-shell';
import type { ImageryMode } from './imagery-modes';
import { atlasForPatch, type MosaicLibrary, type MosaicPatch } from './mosaic-library';
import { coordinateText, locateScene } from './scene-location';
import type { MapPhotoTile } from './imagery-collection';

export type SatelliteSource = {
  index: number;
  column: number;
  row: number;
  region: string;
  itemId: string;
  acquiredAt?: string;
  cloudCoverPercent?: number;
  sceneBoundingBox: [number, number, number, number];
  thumbnailUrl: string;
  thumbnailDimensions?: [number, number];
  cropPixels?: [number, number, number, number];
  imageryModes?: ImageryMode[];
  stacItemUrl?: string;
  mapTile?: MapPhotoTile;
};

export function buildTileDetails(
  source: SatelliteSource,
  imageryMode: ImageryMode,
  onExplore: (source: SatelliteSource) => void,
  mosaic?: { library: MosaicLibrary; patch: MosaicPatch },
): HTMLElement {
  const details = document.createElement('div');
  details.className = 'tile-details';
  details.dataset.sourceIndex = String(source.index);
  details.dataset.imageryMode = imageryMode;
  if (mosaic) details.dataset.patchIndex = String(mosaic.patch.index);

  const photoLink = document.createElement('button');
  photoLink.type = 'button';
  photoLink.className = 'tile-photo-link scene-photo-frame';
  photoLink.id = 'explore-tile-location';
  photoLink.setAttribute('aria-label', `Explore the scene near ${source.region} on this map`);
  photoLink.title = 'Explore this location';
  photoLink.addEventListener('click', () => onExplore(source));
  const preview = document.createElement('div');
  preview.id = 'tile-preview';
  preview.className = 'tile-preview';
  preview.dataset.sourceIndex = String(source.index);
  preview.setAttribute('role', 'img');
  preview.setAttribute('aria-label', `Satellite image crop from the Sentinel-2 scene near ${source.region}`);
  if (mosaic) {
    const { library, patch } = mosaic;
    const atlas = atlasForPatch(library, patch);
    preview.dataset.patchIndex = String(patch.index);
    preview.style.backgroundImage = `url("${atlas.url}")`;
    preview.style.backgroundSize = `${atlas.columns * 100}% ${atlas.rows * 100}%`;
    preview.style.backgroundPosition = `${atlas.column / Math.max(1, atlas.columns - 1) * 100}% ${atlas.row / Math.max(1, atlas.rows - 1) * 100}%`;
  } else {
    preview.style.backgroundPosition = `${source.column / 3 * 100}% ${source.row / 3 * 100}%`;
  }
  // The atlas is a lightweight fallback. Never stretch its 64px tile into the
  // large detail photograph once the native crop is available.
  if (mosaic?.patch.previewUrl) {
    const image = document.createElement('img');
    image.className = 'tile-detail-image';
    image.alt = '';
    image.decoding = 'async';
    image.width = mosaic.patch.previewWidth ?? 340;
    image.height = mosaic.patch.previewHeight ?? 340;
    image.hidden = true;
    preview.dataset.quality = 'loading';
    image.onload = () => {
      // This closure only updates its own preview, even after another tile
      // has replaced the panel while the request was in flight.
      image.hidden = false;
      preview.dataset.quality = 'native';
    };
    image.onerror = () => {
      preview.dataset.quality = 'fallback';
      image.remove();
    };
    preview.append(image);
    image.src = mosaic.patch.previewUrl;
  }
  photoLink.append(preview);

  const title = document.createElement('h2');
  title.className = 'scene-card-title tile-title';
  title.textContent = source.region.split(' · ')[0];
  const row = document.createElement('div');
  row.className = 'location-coordinate-row';
  const position = document.createElement('span');
  position.className = 'tile-coordinates scene-coordinate-text';
  position.textContent = 'Locating…';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'scene-copy';
  copy.title = 'Copy coordinates';
  copy.setAttribute('aria-label', 'Copy coordinates');
  copy.innerHTML = icon('copy');
  copy.hidden = true;
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(position.textContent!);
      copy.dataset.copied = 'true';
      copy.title = 'Coordinates copied';
      copy.setAttribute('aria-label', 'Coordinates copied');
      status.textContent = 'Coordinates copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(position);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      status.textContent = 'Coordinates selected. Press Control+C or Command+C to copy.';
    }
  });
  void locateScene(source).then(location => {
    position.textContent = coordinateText(location.center);
    position.setAttribute('aria-label', `Latitude ${location.center[0].toFixed(5)}, longitude ${location.center[1].toFixed(5)}`);
    position.dataset.quality = 'projected';
    copy.hidden = false;
  }).catch(() => {
    position.textContent = 'Location unavailable';
    position.dataset.quality = 'unavailable';
  });
  row.append(position, copy);
  details.append(photoLink, title, row, status);
  return details;
}
