import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { SatelliteSource } from './tile-details';
import { coordinateText, locateScene, type SceneLocation } from './scene-location';
import { IMAGERY_COLLECTION, MAP_ATTRIBUTION, mapTileUrl } from './imagery-collection';

class ConsistentSatelliteLayer extends L.TileLayer {
  override getTileUrl(coords: L.Coords): string { return mapTileUrl(coords); }
}

export type SceneImage = { url: string; width: number; height: number };

/** A geographic camera and a separate original-photo card; neither owns media. */
export class LocationMap {
  private map: L.Map | undefined;
  private tiles: L.TileLayer | undefined;
  private marker: L.CircleMarker | undefined;
  private image: HTMLImageElement | undefined;
  private source: SatelliteSource | undefined;
  private sceneImage: SceneImage | undefined;
  private sceneLocation: SceneLocation | undefined;
  private point: [number, number] | undefined;
  private pointLabel = 'Photo center';
  private request = 0;
  private locationState: 'loading' | 'ready' | 'error' = 'loading';
  private photoState: 'loading' | 'ready' | 'error' = 'loading';
  private tileErrors = 0;
  private mapNotice = '';
  private cameraMoved = false;
  private active = false;
  private readonly events = new AbortController();
  private readonly resizeObserver: ResizeObserver;
  private readonly container = document.getElementById('location-map')!;
  private readonly photo = document.getElementById('location-photo')!;
  private readonly wrapper = document.getElementById('location-view')!;
  private readonly banner = document.getElementById('location-banner')!;
  private readonly coordinates = document.getElementById('location-coordinates')!;
  private readonly notice = document.getElementById('location-map-status')!;
  private readonly retry = document.getElementById('location-map-retry') as HTMLButtonElement;
  private readonly copy = document.getElementById('location-copy-coordinates') as HTMLButtonElement;
  private readonly copyStatus = document.getElementById('location-copy-status')!;

  constructor(private readonly onCameraChange: () => void, onBack: () => void) {
    const options = { signal: this.events.signal };
    document.getElementById('back-to-video')!.addEventListener('click', onBack, options);
    this.retry.addEventListener('click', () => {
      if (this.locationState === 'error') void this.loadLocation();
      if (this.photoState === 'error') this.loadPhoto();
      if (this.tileErrors) this.tiles?.redraw();
    }, options);
    const selectPhotoPoint = (clientX: number, clientY: number) => {
      const bounds = this.image?.getBoundingClientRect();
      if (!this.active || this.photoState !== 'ready' || !this.sceneLocation || !this.sceneImage || !bounds) return;
      const x = (clientX - bounds.left) / bounds.width * this.sceneImage.width;
      const y = (clientY - bounds.top) / bounds.height * this.sceneImage.height;
      if (x < 0 || y < 0 || x > this.sceneImage.width || y > this.sceneImage.height) return;
      this.point = this.sceneLocation.pointAt(x, y);
      this.pointLabel = 'Selected point';
      this.updatePoint();
      this.recenter();
      this.container.focus({ preventScroll: true });
    };
    this.photo.addEventListener('dblclick', event => {
      event.preventDefault();
      selectPhotoPoint(event.clientX, event.clientY);
    }, options);
    this.photo.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const bounds = this.image?.getBoundingClientRect();
      if (bounds) selectPhotoPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    }, options);
    this.copy.addEventListener('click', async () => {
      if (!this.point) return;
      const text = coordinateText(this.point);
      try {
        await navigator.clipboard.writeText(text);
        if (this.active && this.point && coordinateText(this.point) === text) {
          this.copy.dataset.copied = 'true';
          this.copy.title = 'Coordinates copied';
          this.copy.setAttribute('aria-label', 'Coordinates copied');
          this.copyStatus.textContent = 'Coordinates copied';
        }
      } catch {
        if (!this.active || !this.point || coordinateText(this.point) !== text) return;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(this.coordinates);
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.copyStatus.textContent = 'Coordinates selected. Press Control+C or Command+C to copy.';
      }
    }, options);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.active) this.map?.invalidateSize({ pan: false, animate: false });
    });
    this.resizeObserver.observe(this.wrapper);
  }

  get isActive(): boolean { return this.active; }
  get zoom(): number { return this.map?.getZoom() ?? 0; }
  get zoomLabel(): string { return `Zoom ${this.zoom}`; }
  get canZoomIn(): boolean { return this.zoom < (this.map?.getMaxZoom() ?? IMAGERY_COLLECTION.maxZoom); }
  get canZoomOut(): boolean { return this.zoom > (this.map?.getMinZoom() ?? 2); }

  show(source: SatelliteSource, image: SceneImage): void {
    this.request++;
    this.source = source;
    this.sceneImage = image;
    this.sceneLocation = undefined;
    this.point = undefined;
    this.pointLabel = 'Photo center';
    this.marker?.remove();
    this.locationState = 'loading';
    this.active = true;
    this.wrapper.hidden = false;
    this.banner.hidden = false;
    this.wrapper.dataset.locationMode = 'map';
    document.getElementById('player')!.dataset.view = 'location';
    document.getElementById('location-title')!.textContent = source.region.split(' · ')[0];
    this.coordinates.textContent = 'Locating…';
    this.coordinates.removeAttribute('aria-label');
    this.copy.hidden = true;
    this.resetCopy();
    for (const element of [this.container, this.photo]) {
      element.dataset.sourceIndex = String(source.index);
      delete element.dataset.photoLatitude;
      delete element.dataset.photoLongitude;
    }
    this.ensureMap();
    this.map!.invalidateSize({ pan: false, animate: false });
    this.recenter();
    this.cameraMoved = false;
    if (!this.map!.hasLayer(this.tiles!)) this.tiles!.addTo(this.map!);
    this.loadPhoto();
    void this.loadLocation();
    this.container.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    this.request++;
    this.tiles?.remove();
    this.wrapper.hidden = true;
    this.banner.hidden = true;
    document.getElementById('player')!.dataset.view = 'video';
    this.notice.hidden = true;
    this.retry.hidden = true;
  }

  zoomBy(amount: number): void {
    this.map?.setZoom(this.zoom + amount, { animate: false });
  }

  recenter(): void {
    if (!this.map || !this.source) return;
    if (this.point && this.pointLabel === 'Selected point') {
      this.map.setView(this.point, 12, { animate: false });
      return;
    }
    const [west, south, east, north] = this.sceneLocation?.bounds ?? this.source.sceneBoundingBox;
    const size = this.map.getSize();
    const zoom = this.map.getBoundsZoom(L.latLngBounds([south, west], [north, east]), false,
      L.point(Math.min(96, size.x * .2), Math.min(300, size.y * .36)));
    const center = this.point ?? [(south + north) / 2, (west + east) / 2] as [number, number];
    this.map.setView(center, Math.max(2, Math.min(11, zoom)), { animate: false });
  }

  dispose(): void {
    this.request++;
    this.active = false;
    this.events.abort();
    this.resizeObserver.disconnect();
    this.detachImage();
    this.map?.remove();
  }

  private ensureMap(): void {
    if (this.map) return;
    this.map = L.map(this.container, {
      zoomControl: false, minZoom: IMAGERY_COLLECTION.minZoom, maxZoom: IMAGERY_COLLECTION.maxZoom,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    });
    this.map.attributionControl.setPrefix(false);
    this.container.dataset.collection = IMAGERY_COLLECTION.id;
    this.tiles = new ConsistentSatelliteLayer(IMAGERY_COLLECTION.remoteTileUrl, {
      attribution: MAP_ATTRIBUTION, minZoom: IMAGERY_COLLECTION.minZoom, maxZoom: IMAGERY_COLLECTION.maxZoom,
      maxNativeZoom: IMAGERY_COLLECTION.maxNativeZoom, crossOrigin: true,
      keepBuffer: 1, updateWhenIdle: true, referrerPolicy: 'strict-origin-when-cross-origin',
    });
    this.tiles.on('loading', () => { this.tileErrors = 0; this.mapNotice = 'Loading map…'; this.updateNotice(); });
    this.tiles.on('tileerror', () => { this.tileErrors++; });
    this.tiles.on('load', () => {
      this.mapNotice = this.tileErrors ? 'Some map images could not load.' : '';
      this.updateNotice();
    });
    this.map.on('movestart', () => { this.cameraMoved = true; });
    this.map.on('moveend zoomend', () => {
      const position = this.map!.getCenter();
      this.container.dataset.latitude = String(position.lat);
      this.container.dataset.longitude = String(position.lng);
      this.container.dataset.zoom = String(this.map!.getZoom());
      if (this.active) this.onCameraChange();
    });
  }

  private detachImage(): void {
    if (!this.image) return;
    this.image.onload = this.image.onerror = null;
    this.image.remove();
    this.image = undefined;
  }

  private loadPhoto(): void {
    if (!this.sceneImage || !this.source) return;
    this.detachImage();
    this.photoState = 'loading';
    this.photo.dataset.quality = 'loading';
    const image = new Image();
    image.width = this.sceneImage.width;
    image.height = this.sceneImage.height;
    image.alt = `Original satellite photograph near ${this.source.region}`;
    image.draggable = false;
    image.decoding = 'async';
    this.image = image;
    image.onload = () => {
      if (this.image !== image) return;
      this.photoState = 'ready';
      this.photo.dataset.quality = 'native';
      this.updateNotice();
    };
    image.onerror = () => {
      if (this.image !== image) return;
      this.photoState = 'error';
      this.photo.dataset.quality = 'error';
      this.updateNotice();
    };
    this.photo.replaceChildren(image);
    image.src = this.sceneImage.url;
    this.updateNotice();
  }

  private async loadLocation(): Promise<void> {
    if (!this.source) return;
    const source = this.source;
    const request = ++this.request;
    this.locationState = 'loading';
    this.coordinates.textContent = 'Locating…';
    this.updateNotice();
    try {
      const location = await locateScene(source);
      if (!this.active || request !== this.request) return;
      this.sceneLocation = location;
      this.point = location.center;
      this.locationState = 'ready';
      this.updatePoint();
      if (!this.cameraMoved) this.recenter();
    } catch {
      if (!this.active || request !== this.request) return;
      this.locationState = 'error';
      this.coordinates.textContent = 'Location unavailable';
    }
    this.updateNotice();
  }

  private resetCopy(): void {
    delete this.copy.dataset.copied;
    this.copy.title = 'Copy coordinates';
    this.copy.setAttribute('aria-label', 'Copy coordinates');
    this.copyStatus.textContent = '';
  }

  private updatePoint(): void {
    if (!this.point || !this.map) return;
    this.coordinates.textContent = coordinateText(this.point);
    this.coordinates.setAttribute('aria-label', `Latitude ${this.point[0].toFixed(5)}, longitude ${this.point[1].toFixed(5)}`);
    this.copy.hidden = false;
    this.resetCopy();
    for (const element of [this.container, this.photo]) {
      element.dataset.photoLatitude = String(this.point[0]);
      element.dataset.photoLongitude = String(this.point[1]);
    }
    this.marker?.remove();
    this.marker = L.circleMarker(this.point, { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 })
      .bindTooltip(this.pointLabel, { direction: 'top', offset: [0, -8] }).addTo(this.map);
  }

  private updateNotice(): void {
    this.container.dataset.locationState = this.locationState;
    if (!this.active) return;
    const photoNotice = this.photoState === 'error' ? 'Photo unavailable' : '';
    const text = [photoNotice, this.mapNotice].filter(Boolean).join(' ');
    this.notice.textContent = text;
    this.notice.hidden = !text;
    this.retry.hidden = this.locationState !== 'error' && this.photoState !== 'error' && !this.tileErrors;
    this.retry.textContent = this.locationState === 'error' ? 'Retry location' : this.photoState === 'error' ? 'Retry photo' : 'Retry map';
  }
}
