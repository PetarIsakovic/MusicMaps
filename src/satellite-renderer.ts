import { DEFAULT_IMAGERY_MODE, IMAGERY_MODES, type ImageryMode } from './imagery-modes';
import { atlasPages, atlasForPatch, loadMosaicLibrary, type MosaicLibrary } from './mosaic-library';
import { BASE_DENSITY_SCALE, CELL_STRIDE, MAX_DENSITY, STATE_SLOTS, VERTEX_SHADER, DISPLAY_SHADER, MATCH_SHADER, PHOTO_BOUNDS_SHADER } from './mosaic-shaders';

export type VisualSettings = {
  density: number;
  organic: number;
  contrast: number;
};

/**
 * A camera over the canvas's covered video area. Zoom is 1–4; offsets are in
 * normalized viewport coordinates before the source's cover crop. Positive x
 * looks right and positive y looks up. To follow a pointer drag, subtract
 * dx / width / zoom from x and add dy / height / zoom to y.
 */
export type ViewState = { zoom: number; x: number; y: number };

/** Source atlas indices follow the image's top-left, row-major metadata. */
export type TileSelection = { atlasIndex: number; cellX: number; cellY: number; patchIndex?: number; subCell?: number; cellScale?: number };

const DEFAULT_SETTINGS: VisualSettings = { density: 260, organic: 0.7, contrast: 1 };
const MAX_DRAWING_PIXELS = 1_500_000;
const DETAIL_SETTLE_MS = 300;
const DETAIL_UPLOAD_ROWS = 64;
// Matching and display run separately; reuse their units to stay within eight.
const ATLAS_UNITS = [1, 6, 7, 2];
const DETAIL_UNIT = 3;

/**
 * Draws decoded video pixels as organic cells containing satellite imagery.
 * This class never calls play(), pause(), or assigns any media property.
 * The caller schedules frames from the media element's clock and passes the
 * corresponding media time; skipped calls simply skip visual frames.
 */
export class SatelliteRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly matchProgram: WebGLProgram;
  private readonly photoProgram: WebGLProgram;
  private readonly photoUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly matchUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly featuresTexture: WebGLTexture;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly videoTexture: WebGLTexture;
  private readonly atlasTextures: WebGLTexture[] = [];
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private settings: VisualSettings = { ...DEFAULT_SETTINGS };
  private view: ViewState = { zoom: 1, x: 0, y: 0 };
  private readonly atlasTileSizes = [1, 1, 1, 1];
  private detailPage = -1;
  private detailPatch = -1;
  private detailTexture: WebGLTexture | null = null;
  private detailTileSize = 0;
  private detailFocusDirty = true;
  private detailFocusPatch: number | null = null;
  private detailRevision = 0;
  private detailAfter = 0;
  private detailTimer: number | undefined;
  private detailBusy = false;
  private detailUploadFrame: number | undefined;
  private detailUploadContinue: (() => void) | undefined;
  private detailState: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  private sourceWidth = 1;
  private sourceHeight = 1;
  private hasVideo = false;
  private disposed = false;
  private selection: TileSelection | null = null;
  private library: MosaicLibrary | null = null;
  private imageryMode: ImageryMode = DEFAULT_IMAGERY_MODE;
  private readonly lookupTextures = new Map<ImageryMode, WebGLTexture>();
  private pickFramebuffer: WebGLFramebuffer | null = null;
  private pickTexture: WebGLTexture | null = null;
  private stateTargets: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }[] = [];
  private photoTarget: { texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null;
  private stateColumns = 0;
  private stateRows = 0;
  private stateIndex = 0;
  private stateDirty = true;
  private historyValid = false;
  private lastMediaTime = Number.NaN;
  private lastSource = '';
  private observedVideo: HTMLVideoElement | null = null;
  private videoEvents = new AbortController();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Your browser does not support WebGL.');
    this.gl = gl;

    const highPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const fragmentSource = (shader: string) => highPrecision?.precision ? shader
      : shader.replace('precision highp float;', 'precision mediump float;\n#define LIMITED_PRECISION');
    this.program = this.createProgram(VERTEX_SHADER, fragmentSource(DISPLAY_SHADER));
    this.matchProgram = this.createProgram(VERTEX_SHADER, fragmentSource(MATCH_SHADER));
    this.photoProgram = this.createProgram(VERTEX_SHADER, fragmentSource(PHOTO_BOUNDS_SHADER));
    this.photoUniforms = Object.fromEntries(['u_cells', 'u_stateSize', 'u_organic']
      .map(name => [name, gl.getUniformLocation(this.photoProgram, name)]));
    this.matchUniforms = Object.fromEntries([
      'u_video', 'u_lookup', 'u_features', 'u_previous', 'u_resolution', 'u_sourceSize', 'u_density',
      'u_organic', 'u_stateSize', 'u_featureGrid', 'u_lookupSize', 'u_lookupVariants', 'u_contrast',
      'u_hasVideo', 'u_history', 'u_patchCount',
    ].map(name => [name, gl.getUniformLocation(this.matchProgram, name)]));
    gl.useProgram(this.program);

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Unable to allocate the satellite geometry.');
    this.vertexBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.videoTexture = this.createTexture([0, 0, 0, 255]);
    for (const unit of ATLAS_UNITS) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      this.atlasTextures.push(this.createTexture([104, 119, 82, 255]));
    }
    gl.activeTexture(gl.TEXTURE3);
    this.featuresTexture = this.createTexture([104, 119, 82, 0]);
    this.uniforms = Object.fromEntries(
      ['u_atlasSecond', 'u_atlasThird', 'u_atlasFourth', 'u_atlasRows', 'u_video', 'u_atlas', 'u_resolution', 'u_sourceSize', 'u_density', 'u_organic', 'u_contrast', 'u_hasVideo', 'u_detailPatch', 'u_view', 'u_pickMode', 'u_pickUV', 'u_selection', 'u_lookup', 'u_atlasGrid', 'u_patchCount', 'u_lookupSize', 'u_lookupVariants', 'u_tileInset', 'u_pickCell', 'u_pickSub', 'u_cells', 'u_stateSize', 'u_photoBounds', 'u_detailAtlas']
        .map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );
    gl.uniform1i(this.uniforms.u_video, 0);
    gl.uniform1i(this.uniforms.u_atlas, 1);
    gl.uniform1i(this.uniforms.u_atlasSecond, 6);
    gl.uniform1i(this.uniforms.u_atlasThird, 7);
    gl.uniform1i(this.uniforms.u_atlasFourth, 2);
    gl.uniform1i(this.uniforms.u_lookup, 2);
    gl.uniform1i(this.uniforms.u_cells, 4);
    gl.uniform1i(this.uniforms.u_photoBounds, 5);
    gl.uniform1i(this.uniforms.u_detailAtlas, DETAIL_UNIT);
    gl.activeTexture(gl.TEXTURE2);
    for (const mode of IMAGERY_MODES) this.lookupTextures.set(mode.id, this.createTexture([0, 0, 0, 255]));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.resize();
  }

  async loadAtlas(): Promise<void> {
    const library = await loadMosaicLibrary();
    const pages = atlasPages(library);
    if (pages.length > 4 || library.patches.length > 16384) throw new Error('The satellite library exceeds the supported page count.');
    const [atlases, features, ...lookups] = await Promise.all([
      Promise.all(pages.map(page => this.loadImage(page.url))), this.loadImage(library.features.url),
      ...IMAGERY_MODES.map(mode => this.loadImage(library.lookup.urls[mode.id])),
    ]);
    if (this.disposed) return;
    this.library = library;
    const gl = this.gl;
    pages.forEach((page, index) => {
      this.uploadAtlas(index, atlases[index], page.tileSize);
    });
    this.canvas.dataset.imageryPages = String(pages.length);
    // Lookup rows are RGB green bins, not geographic image rows. Preserve
    // their byte values and nearest-neighbor addressing exactly.
    gl.activeTexture(gl.TEXTURE2);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    IMAGERY_MODES.forEach((mode, index) => {
      gl.bindTexture(gl.TEXTURE_2D, this.lookupTextures.get(mode.id)!);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lookups[index]);
    });
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.featuresTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, features);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    this.stateDirty = true;
    this.historyValid = false;
    this.draw();
  }

  render(video: HTMLVideoElement, time: number): void {
    if (this.disposed || this.gl.isContextLost() || video.readyState < 2 || !video.videoWidth || !Number.isFinite(time)) return;
    const gl = this.gl;
    if (this.observedVideo !== video) {
      this.videoEvents.abort();
      this.videoEvents = new AbortController();
      this.observedVideo = video;
      for (const event of ['seeking', 'emptied', 'loadstart']) video.addEventListener(event, () => {
        this.historyValid = false;
        this.lastMediaTime = Number.NaN;
      }, { signal: this.videoEvents.signal });
    }
    // Only consecutive source timestamps can share choices. Seeks, replacement,
    // backwards time and long rendering stalls match the new frame immediately.
    if (video.currentSrc !== this.lastSource || !Number.isFinite(this.lastMediaTime)
        || time < this.lastMediaTime || time - this.lastMediaTime > 0.25) this.historyValid = false;
    this.lastSource = video.currentSrc;
    this.lastMediaTime = time;
    this.stateDirty = true;
    this.sourceWidth = video.videoWidth;
    this.sourceHeight = video.videoHeight;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    // Upload the currently decoded media frame. No frame queue or elapsed-time
    // accumulator can get ahead of, or fall behind, the source's audio clock.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this.hasVideo = true;
    this.draw();
  }

  renderIdle(): void {
    this.stateDirty = true;
    this.historyValid = false;
    this.hasVideo = false;
    this.draw();
  }

  resize(): void {
    if (this.disposed) return;
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_DRAWING_PIXELS / (width * height)));
    const pixelWidth = Math.max(1, Math.floor(width * scale));
    const pixelHeight = Math.max(1, Math.floor(height * scale));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.stateDirty = true;
      this.historyValid = false;
      this.invalidateDetailFocus();
    }
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    this.draw();
  }

  setSettings(settings: VisualSettings): void {
    const clamp = (value: number, min: number, max: number, fallback: number) =>
      Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    this.stateDirty = true;
    this.historyValid = false;
    this.invalidateDetailFocus();
    this.settings = {
      density: clamp(settings.density, 24, MAX_DENSITY, DEFAULT_SETTINGS.density),
      organic: clamp(settings.organic, 0, 1, DEFAULT_SETTINGS.organic),
      contrast: clamp(settings.contrast, 0.7, 1.6, DEFAULT_SETTINGS.contrast),
    };
    this.draw();
  }

  /** Change preloaded imagery and redraw the cached frame without media work. */
  setImageryMode(mode: ImageryMode): void {
    this.imageryMode = mode;
    this.invalidateDetailFocus();
    this.stateDirty = true;
    this.historyValid = false;
    if (this.selection) this.selection = this.readSelection([0.5, 0.5], this.selection);
    this.draw();
  }

  /** The same selected cell, with the source image from the active imagery mode. */
  getSelection(): TileSelection | null {
    return this.selection ? { ...this.selection } : null;
  }

  /** Redraw the cached source frame without touching the media clock. */
  setView(view: ViewState): void {
    const zoom = Number.isFinite(view.zoom) ? Math.min(4, Math.max(1, view.zoom)) : 1;
    const limit = 0.5 * (1 - 1 / zoom);
    const offset = (value: number) => Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0;
    const next = { zoom, x: offset(view.x), y: offset(view.y) };
    if (next.zoom === this.view.zoom && next.x === this.view.x && next.y === this.view.y) return;
    this.invalidateDetailFocus();
    this.view = next;
    this.draw();
  }

  /** Include input at zoom limits, even when no new camera draw is needed. */
  deferDetailForInteraction(): void {
    if (this.disposed) return;
    this.invalidateDetailFocus();
    this.requestDetailAtlas();
  }

  /** Pick with the rendering shader so its organic geometry and hash agree exactly. */
  pickTile(clientX: number, clientY: number): TileSelection | null {
    if (this.disposed || this.gl.isContextLost() || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null;

    // Match the center of the displayed drawing-buffer pixel, including CSS
    // scaling and the renderer's pixel budget. WebGL's origin is bottom-left.
    const pixelX = Math.floor((clientX - bounds.left) / bounds.width * this.canvas.width);
    const pixelY = this.canvas.height - 1 - Math.floor((clientY - bounds.top) / bounds.height * this.canvas.height);
    const pickUV: [number, number] = [
      (pixelX + 0.5) / this.canvas.width,
      (pixelY + 0.5) / this.canvas.height,
    ];
    this.selection = this.readSelection(pickUV);
    this.invalidateDetailFocus(this.selection?.patchIndex ?? null);
    this.draw();
    return this.getSelection();
  }

  private readSelection(pickUV: [number, number], cell?: TileSelection): TileSelection | null {
    if (!this.library) return null;
    const gl = this.gl;
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const wasDithering = gl.isEnabled(gl.DITHER);
    const pixel = new Uint8Array(4);
    try {
      if (!this.ensurePickTarget()) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
      gl.viewport(0, 0, 1, 1);
      gl.disable(gl.DITHER);
      this.draw(pickUV, cell);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
      gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);
      if (wasDithering) gl.enable(gl.DITHER);
      gl.uniform1f(this.uniforms.u_pickMode, 0);
      gl.uniform2f(this.uniforms.u_pickUV, 0, 0);
      gl.uniform3f(this.uniforms.u_pickCell, 0, 0, 0);
    }
    if (gl.isContextLost()) return null;
    const patch = this.library.patches[pixel[0] + (pixel[1] % 64) * 256];
    if (!patch) return null;
    const address = pixel[2] + pixel[3] * 256 + Math.floor(pixel[1] / 64) * 65536;
    const code = address % 5;
    const position = Math.floor(address / 5);
    return { atlasIndex: patch.sourceIndex, patchIndex: patch.index,
      cellX: position % CELL_STRIDE - 1, cellY: Math.floor(position / CELL_STRIDE) - 1,
      subCell: code - 1, cellScale: code ? 0.5 : 1 };
  }

  clearSelection(): void {
    this.selection = null;
    this.draw();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.videoEvents.abort();
    window.clearTimeout(this.detailTimer);
    if (this.detailUploadFrame !== undefined) cancelAnimationFrame(this.detailUploadFrame);
    this.detailUploadContinue?.();
    this.detailUploadContinue = undefined;
    const gl = this.gl;
    gl.deleteTexture(this.detailTexture);
    gl.deleteTexture(this.videoTexture);
    gl.deleteTexture(this.featuresTexture);
    for (const target of this.stateTargets) {
      gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer);
    }
    gl.deleteProgram(this.matchProgram);
    gl.deleteProgram(this.photoProgram);
    if (this.photoTarget) {
      gl.deleteTexture(this.photoTarget.texture); gl.deleteFramebuffer(this.photoTarget.framebuffer);
    }
    for (const texture of this.atlasTextures) gl.deleteTexture(texture);
    for (const texture of this.lookupTextures.values()) gl.deleteTexture(texture);
    gl.deleteTexture(this.pickTexture);
    gl.deleteFramebuffer(this.pickFramebuffer);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteProgram(this.program);
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The satellite imagery could not be loaded.'));
      image.src = url;
    });
  }

  /** Upload one independent page; smaller devices retain every photograph. */
  private uploadAtlas(index: number, image: HTMLImageElement, requestedSize: number): number {
    const gl = this.gl;
    const page = atlasPages(this.library!)[index];
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const tileSize = Math.min(requestedSize, Math.floor(Math.min(maxSize / page.columns, maxSize / page.rows)));
    let pixels: TexImageSource = image;
    if (tileSize < requestedSize) {
      const resized = document.createElement('canvas');
      resized.width = page.columns * tileSize;
      resized.height = page.rows * tileSize;
      resized.getContext('2d')!.drawImage(image, 0, 0, resized.width, resized.height);
      pixels = resized;
    }
    gl.activeTexture(gl.TEXTURE0 + ATLAS_UNITS[index]);
    // Separate allocation lets optional high resolution fail without losing a page.
    const texture = this.createTexture([104, 119, 82, 255]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Keep the atlas RGB values unchanged; browser-default conversion can tint JPEG pixels.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTextures[index]);
      throw new Error('Satellite texture unavailable');
    }
    gl.deleteTexture(this.atlasTextures[index]);
    this.atlasTextures[index] = texture;
    this.atlasTileSizes[index] = tileSize;
    this.canvas.dataset.imageryResolution = String(Math.max(...this.atlasTileSizes));
    return tileSize;
  }

  /** Camera changes keep the resident images; optional work waits for rest. */
  private invalidateDetailFocus(patch: number | null = null): void {
    this.detailFocusDirty = true;
    this.detailFocusPatch = patch;
    this.detailRevision++;
    this.detailAfter = performance.now() + DETAIL_SETTLE_MS;
    window.clearTimeout(this.detailTimer);
    this.detailTimer = undefined;
  }

  private requestDetailAtlas(): void {
    if (!this.library?.detailAtlas || !this.detailFocusDirty || this.detailBusy || this.detailTimer !== undefined) return;
    const footprint = Math.max(this.canvas.width, this.canvas.height) / (this.settings.density * BASE_DENSITY_SCALE) * this.view.zoom;
    if (footprint <= this.library.layout.tileSize * 0.875) {
      this.detailFocusDirty = false;
      return;
    }
    this.detailTimer = window.setTimeout(() => {
      this.detailTimer = undefined;
      if (!this.disposed) void this.loadFocusedDetail();
    }, Math.max(0, this.detailAfter - performance.now()));
  }

  private nextDetailFrame(): Promise<void> {
    return new Promise(resolve => {
      this.detailUploadContinue = resolve;
      this.detailUploadFrame = requestAnimationFrame(() => {
        this.detailUploadFrame = undefined;
        this.detailUploadContinue = undefined;
        resolve();
      });
    });
  }

  private updateDetailStatus(): void {
    this.canvas.dataset.detailPage = String(this.detailPage);
    this.canvas.dataset.detailQuality = this.detailState;
    this.canvas.dataset.imageryResolution = String(Math.max(this.detailTileSize, ...this.atlasTileSizes));
  }

  private async loadFocusedDetail(): Promise<void> {
    if (!this.library || this.disposed || this.detailBusy) return;
    if (performance.now() < this.detailAfter) { this.requestDetailAtlas(); return; }
    this.detailFocusDirty = false;
    this.detailBusy = true;
    const revision = this.detailRevision;
    const gl = this.gl;
    let pendingTexture: WebGLTexture | null = null;
    const stale = () => this.disposed || gl.isContextLost() || revision !== this.detailRevision;
    try {
      // This synchronous GPU readback happens once after the gesture, never in
      // a wheel/pointer handler or the continuous camera drawing path.
      const focused = this.detailFocusPatch ?? this.readSelection([0.5, 0.5])?.patchIndex;
      if (focused === undefined) return;
      const patch = this.library.patches[focused];
      const pageIndex = atlasForPatch(this.library, patch).pageIndex;
      if (pageIndex === this.detailPage && focused === this.detailPatch) return;
      if (!patch.previewUrl) return;
      this.detailState = 'loading';
      this.updateDetailStatus();
      const image = await this.loadImage(patch.previewUrl);
      await image.decode();
      if (stale()) return;

      // Keep the base atlas resident and upload only the selected lossless tile.
      gl.deleteTexture(this.detailTexture);
      this.detailTexture = null;
      this.detailPatch = -1;
      gl.activeTexture(gl.TEXTURE0 + DETAIL_UNIT);
      pendingTexture = this.createTexture([104, 119, 82, 255]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Detail texture unavailable');
      this.detailTexture = pendingTexture;
      pendingTexture = null;
      this.detailPage = pageIndex;
      this.detailPatch = focused;
      this.detailTileSize = patch.previewWidth ?? 256;
      this.detailState = 'ready';
    } catch {
      if (!stale()) this.detailState = 'unavailable';
    } finally {
      gl.deleteTexture(pendingTexture);
      this.detailBusy = false;
      if (!this.disposed) {
        if (stale()) this.detailState = this.detailTexture ? 'ready' : 'idle';
        this.updateDetailStatus();
        this.draw();
      }
    }
  }

  private draw(pickUV?: [number, number], cell?: TileSelection): void {
    if (this.disposed || this.gl.isContextLost()) return;
    this.updateCellState();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    this.atlasTextures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + ATLAS_UNITS[index]);
      // Native detail contains one photograph, not an entire atlas page.
      // Keep every other photograph on this page attached to its base texture.
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
    gl.uniform2f(this.uniforms.u_resolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uniforms.u_sourceSize, this.sourceWidth, this.sourceHeight);
    gl.uniform1f(this.uniforms.u_density, this.settings.density);
    gl.uniform1f(this.uniforms.u_organic, this.settings.organic);
    gl.uniform1f(this.uniforms.u_contrast, this.settings.contrast);
    gl.uniform1f(this.uniforms.u_hasVideo, this.hasVideo ? 1 : 0);
    gl.uniform2f(this.uniforms.u_detailPatch, this.detailPatch < 0 ? -1 : this.detailPatch % 256, Math.floor(this.detailPatch / 256));
    gl.uniform3f(this.uniforms.u_view, this.view.zoom, this.view.x, this.view.y);
    gl.uniform1f(this.uniforms.u_pickMode, pickUV ? 1 : 0);
    gl.uniform2f(this.uniforms.u_pickUV, pickUV?.[0] ?? 0, pickUV?.[1] ?? 0);
    gl.uniform4f(this.uniforms.u_selection, this.selection?.cellX ?? 0, this.selection?.cellY ?? 0, this.selection?.subCell ?? -1, this.selection ? 1 : 0);
    const pages = this.library ? atlasPages(this.library) : [];
    gl.uniform2f(this.uniforms.u_atlasGrid, pages[0]?.columns ?? 1, pages[0]?.rows ?? 1);
    gl.uniform4f(this.uniforms.u_atlasRows, pages[0]?.rows ?? 1, pages[1]?.rows ?? 1, pages[2]?.rows ?? 1, pages[3]?.rows ?? 1);
    gl.uniform1f(this.uniforms.u_patchCount, this.library?.patches.length ?? 1);
    gl.uniform1f(this.uniforms.u_lookupSize, this.library?.lookup.size ?? 1);
    gl.uniform1f(this.uniforms.u_lookupVariants, this.library?.lookup.variants ?? 1);
    const tileSize = (index: number) => this.atlasTileSizes[index];
    gl.uniform4f(this.uniforms.u_tileInset, 0.5 / tileSize(0), 0.5 / tileSize(1), 0.5 / tileSize(2), 0.5 / tileSize(3));
    gl.uniform3f(this.uniforms.u_pickCell, cell?.cellX ?? 0, cell?.cellY ?? 0, cell ? 1 : 0);
    gl.uniform1f(this.uniforms.u_pickSub, cell?.subCell ?? -1);
    gl.uniform2f(this.uniforms.u_stateSize, this.stateColumns, this.stateRows);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTargets[this.stateIndex].texture);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTarget!.texture);
    gl.activeTexture(gl.TEXTURE0 + DETAIL_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.detailTexture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!pickUV) this.requestDetailAtlas();
  }

  /** Match once per cell in a small target; the full canvas only samples IDs. */
  private updateCellState(): void {
    const gl = this.gl;
    const longest = Math.max(this.canvas.width, this.canvas.height);
    const columns = Math.ceil(this.canvas.width / longest * this.settings.density * BASE_DENSITY_SCALE) + 2;
    const rows = Math.ceil(this.canvas.height / longest * this.settings.density * BASE_DENSITY_SCALE) + 2;
    const resized = columns !== this.stateColumns || rows !== this.stateRows;
    if (!resized && !this.stateDirty) return;
    // A pick can request a fresh match while its one-pixel framebuffer is bound.
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const dithering = gl.isEnabled(gl.DITHER);
    try {
      if (resized) {
        for (const target of this.stateTargets) {
          gl.deleteTexture(target.texture);
          gl.deleteFramebuffer(target.framebuffer);
        }
        this.stateTargets = [];
        if (this.photoTarget) {
          gl.deleteTexture(this.photoTarget.texture); gl.deleteFramebuffer(this.photoTarget.framebuffer);
          this.photoTarget = null;
        }
        this.stateColumns = columns;
        this.stateRows = rows;
        this.historyValid = false;
        this.stateIndex = 0;
        gl.activeTexture(gl.TEXTURE4);
        for (let index = 0; index < 3; index++) {
          const texture = gl.createTexture();
          const target = gl.createFramebuffer();
          if (!texture || !target) {
            gl.deleteTexture(texture);
            gl.deleteFramebuffer(target);
            throw new Error('Unable to allocate the satellite matching surface.');
          }
          if (index < 2) this.stateTargets.push({ texture, framebuffer: target });
          else this.photoTarget = { texture, framebuffer: target };
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns * STATE_SLOTS, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, target);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('The satellite matching surface is unavailable.');
        }
      }
      const next = 1 - this.stateIndex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateTargets[next].framebuffer);
      gl.viewport(0, 0, columns * STATE_SLOTS, rows);
      gl.disable(gl.DITHER);
      gl.useProgram(this.matchProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.lookupTextures.get(this.imageryMode)!);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.featuresTexture);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.stateTargets[this.stateIndex].texture);
      const u = this.matchUniforms;
      gl.uniform1i(u.u_video, 0);
      gl.uniform1i(u.u_lookup, 2);
      gl.uniform1i(u.u_features, 3);
      gl.uniform1i(u.u_previous, 4);
      gl.uniform2f(u.u_resolution, this.canvas.width, this.canvas.height);
      gl.uniform2f(u.u_sourceSize, this.sourceWidth, this.sourceHeight);
      gl.uniform2f(u.u_stateSize, columns, rows);
      gl.uniform2f(u.u_featureGrid, this.library?.features.columns ?? 1, this.library?.features.rows ?? 1);
      gl.uniform1f(u.u_density, this.settings.density);
      gl.uniform1f(u.u_organic, this.settings.organic);
      gl.uniform1f(u.u_contrast, this.settings.contrast);
      gl.uniform1f(u.u_lookupSize, this.library?.lookup.size ?? 1);
      gl.uniform1f(u.u_lookupVariants, this.library?.lookup.variants ?? 1);
      gl.uniform1f(u.u_hasVideo, this.hasVideo ? 1 : 0);
      gl.uniform1f(u.u_history, this.historyValid ? 1 : 0);
      gl.uniform1f(u.u_patchCount, this.library?.patches.length ?? 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stateIndex = next;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.photoTarget!.framebuffer);
      gl.useProgram(this.photoProgram);
      gl.bindTexture(gl.TEXTURE_2D, this.stateTargets[this.stateIndex].texture);
      gl.uniform1i(this.photoUniforms.u_cells, 4);
      gl.uniform2f(this.photoUniforms.u_stateSize, columns, rows);
      gl.uniform1f(this.photoUniforms.u_organic, this.settings.organic);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stateDirty = false;
      this.historyValid = this.hasVideo && this.library !== null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      if (dithering) gl.enable(gl.DITHER);
    }
  }

  private ensurePickTarget(): boolean {
    if (this.pickFramebuffer && this.pickTexture) return true;
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!framebuffer || !texture) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return false;
    }
    this.pickFramebuffer = framebuffer;
    this.pickTexture = texture;
    return true;
  }

  private createTexture(pixel: number[]): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate a satellite texture.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixel));
    return texture;
  }

  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to create a satellite shader.');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const details = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Satellite shader compilation failed: ${details}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    let fragment: WebGLShader;
    try {
      fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    } catch (error) {
      gl.deleteShader(vertex);
      throw error;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      throw new Error('Unable to create the satellite renderer.');
    }
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const details = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Satellite renderer linking failed: ${details}`);
    }
    return program;
  }
}
