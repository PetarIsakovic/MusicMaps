import type { TileSelection, ViewState } from './satellite-renderer';
import { buildTileDetails, type SatelliteSource } from './tile-details';
import { DEFAULT_IMAGERY_MODE, getImageryMode, isImageryMode, type ImageryMode } from './imagery-modes';
import { LocationMap } from './location-map';
import { loadMosaicLibrary, type MosaicLibrary } from './mosaic-library';
import { setupPegmanDrag } from './pegman-drag';
import { icon } from './map-shell';
import { IMAGERY_COLLECTION } from './imagery-collection';
import { loadVideoLibrary, sameVideo, type LibraryVideo, type VideoSource } from './video-library';
import { createVideoThumbnails } from './video-thumbnails';

type MapControlsOptions = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  openVideo: (file: VideoSource, autoplay?: boolean, startTime?: number) => void;
  play: () => void;
  openPicker: () => void;
  setView: (view: ViewState) => void;
  onViewInput: () => void;
  pickTile: (clientX: number, clientY: number) => TileSelection | null;
  clearSelection: () => void;
  setImageryMode: (mode: ImageryMode) => TileSelection | null;
  toggleFullscreen: () => void;
};
type SavedMoment = { file: VideoSource; time: number };

const videoTitle = (file: VideoSource) => file.name.replace(/\.(mp4|mov|m4v|webm|ogv|mkv|avi)$/i, '');

/** Map-style chrome owns only local navigation and the visual viewport. */
export function setupMapControls(options: MapControlsOptions) {
  const { video, canvas } = options;
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const abort = new AbortController();
  const eventOptions = { signal: abort.signal };
  const search = element<HTMLInputElement>('map-search');
  const searchResults = element('search-results');
  const thumbnails = createVideoThumbnails(searchResults, abort.signal);
  const chooser = element<HTMLDialogElement>('video-chooser');
  const chooserGrid = element('chooser-videos');
  const chooserThumbnails = createVideoThumbnails(chooser, abort.signal);
  element('chooser-upload').addEventListener('click', options.openPicker, eventOptions);
  element('chooser-retry').addEventListener('click', () => { void refreshVideoLibrary(); }, eventOptions);
  // Keep the first action explicit; the native dialog makes the page behind it inert.
  chooser.addEventListener('cancel', event => event.preventDefault(), eventOptions);
  chooser.addEventListener('keydown', event => event.stopPropagation(), eventOptions);
  chooser.showModal();

  function paintChooser() {
    if (!chooser.open) return;
    chooserThumbnails.reset();
    chooserGrid.replaceChildren();
    for (const file of libraryVideos) {
      const card = button(videoTitle(file), () => activateFile(file, 0, true), 'chooser-video');
      card.prepend(chooserThumbnails.create(file, 'high'));
      chooserGrid.append(card);
    }
    const status = element('chooser-status');
    status.textContent = libraryError ? 'Couldn’t load the demos. Try again or upload your own video.'
      : libraryVideos.length ? '' : 'No demo videos yet. Upload one to get started.';
    status.hidden = !status.textContent;
    element('chooser-retry').hidden = !libraryError;
  }
  const panel = element('map-panel');
  const panelContent = element('panel-content');
  const player = element('player');
  const view: ViewState = { zoom: 1, x: 0, y: 0 };
  let appliedView: ViewState | undefined;
  let viewFrame = 0;
  const recentFiles: VideoSource[] = [];
  let libraryVideos: LibraryVideo[] = [];
  let libraryLoading = false;
  let libraryLoaded = false;
  let libraryError = false;
  const savedMoments: SavedMoment[] = [];
  let currentFile: VideoSource | undefined;
  let activePanel = '';
  let lastTrigger: HTMLElement | undefined;
  let pointer: { id: number; x: number; y: number; startX: number; startY: number; dragged: boolean } | undefined;
  let sources: SatelliteSource[] = [];
  let sourceRequest: Promise<SatelliteSource[]> | undefined;
  let mosaicRequest: Promise<MosaicLibrary> | undefined;
  let panelRequest = 0;
  let imageryMode: ImageryMode = DEFAULT_IMAGERY_MODE;
  const locationMap = new LocationMap(updateCameraControls, returnToVideo);

  async function exploreLocation(source: SatelliteSource) {
    const details = panelContent.querySelector<HTMLElement>('.tile-details');
    const photo = details?.querySelector<HTMLImageElement>('#tile-preview img');
    const locationPatchIndex = details?.dataset.sourceIndex === String(source.index) && details.dataset.patchIndex !== undefined
      ? Number(details.dataset.patchIndex) : undefined;
    const request = panelRequest;
    const library = await loadMosaic().catch(() => undefined);
    if (request !== panelRequest || abort.signal.aborted) return;
    const patch = library?.patches.find(candidate => candidate.sourceIndex === source.index
      && (locationPatchIndex === undefined || candidate.index === locationPatchIndex));
    const sceneImage = {
      url: patch?.previewUrl || photo?.getAttribute('src') || source.thumbnailUrl,
      width: patch?.previewWidth || photo?.width || source.mapTile?.tileSize || 340,
      height: patch?.previewHeight || photo?.height || source.mapTile?.tileSize || 340,
    };
    closePanel(false);
    closePopovers();
    locationMap.show(source, sceneImage);
  }
  function returnToVideo() {
    if (!locationMap.isActive) return;
    locationMap.hide();
    closePanel(false);
    applyView();
    canvas.focus({ preventScroll: true });
  }
  function updateCameraControls() {
    if (!locationMap.isActive) return;
    element('zoom-level').textContent = locationMap.zoomLabel;
    element<HTMLButtonElement>('zoom-in').disabled = !locationMap.canZoomIn;
    element<HTMLButtonElement>('zoom-out').disabled = !locationMap.canZoomOut;
  }
  function changeZoom(amount: number) {
    if (locationMap.isActive) { locationMap.zoomBy(amount); return; }
    view.zoom *= amount > 0 ? 1.25 : 1 / 1.25;
    applyView();
  }

  const formatTime = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
  function bind(id: string, callback: () => void) {
    element(id).addEventListener('click', callback, eventOptions);
  }
  function paragraph(text: string) {
    const paragraph = document.createElement('p');
    paragraph.className = 'panel-copy';
    paragraph.textContent = text;
    return paragraph;
  }
  function button(title: string, callback: () => void, className = 'panel-action', description?: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    const label = document.createElement('span');
    label.textContent = title;
    button.append(label);
    if (description) {
      const detail = document.createElement('small');
      detail.textContent = description;
      button.append(detail);
    }
    button.addEventListener('click', callback);
    return button;
  }
  function closePopovers(except = '') {
    for (const [id, trigger] of [
      ['settings-panel', 'layers-toggle'], ['profile-menu', 'profile-toggle'], ['apps-menu', 'apps-toggle'],
      ['search-results', 'search-button'],
    ]) {
      if (id !== except) {
        element(id).hidden = true;
        element(trigger).setAttribute('aria-expanded', 'false');
      }
    }
  }
  function togglePopover(id: string, trigger: string) {
    const target = element(id);
    const opening = target.hidden;
    closePopovers();
    target.hidden = !opening;
    element(trigger).setAttribute('aria-expanded', String(opening));
    if (opening) { lastTrigger = element(trigger); target.querySelector<HTMLElement>('button, input, a')?.focus(); }
  }
  function closePanel(clearSelection = true) {
    panelRequest++;
    panel.hidden = true;
    activePanel = '';
    delete panel.dataset.mode;
    delete panel.dataset.sourceIndex;
    delete panel.dataset.imageryMode;
    delete panel.dataset.patchIndex;
    if (clearSelection) options.clearSelection();
    player.classList.remove('panel-open');
    for (const id of ['menu-toggle', 'saved-toggle', 'recents-toggle', 'streetview-toggle', 'satellite-canvas']) {
      element(id).setAttribute('aria-expanded', 'false');
    }
  }
  function openPanel(title: string, key: string, trigger: string) {
    closePopovers();
    closePanel(key !== 'tile');
    panel.hidden = false;
    activePanel = key;
    panel.dataset.mode = key;
    panel.scrollTop = 0;
    player.classList.add('panel-open');
    element('panel-title').textContent = title;
    const close = element('panel-close');
    close.classList.toggle('scene-card-back', key === 'tile');
    close.innerHTML = key === 'tile' ? `${icon('arrow')}<span>Back to video</span>` : icon('close');
    close.setAttribute('aria-label', key === 'tile' ? 'Back to video' : 'Close panel');
    panelContent.replaceChildren();
    lastTrigger = element(trigger);
    lastTrigger.setAttribute('aria-expanded', 'true');
  }
  function loadSources(): Promise<SatelliteSource[]> {
    if (sources.length) return Promise.resolve(sources);
    if (!sourceRequest) {
      sourceRequest = loadMosaic().then(library => fetch(library.sourceManifest, { signal: abort.signal })).then(async response => {
        if (!response.ok) throw new Error('Imagery source list unavailable');
        const data = await response.json() as { collectionId: string; sources: SatelliteSource[] };
        if (data.collectionId !== IMAGERY_COLLECTION.id || !Array.isArray(data.sources)
          || data.sources.some(source => source.mapTile?.collectionId !== IMAGERY_COLLECTION.id))
          throw new Error('Imagery locations must belong to the same collection as the map. Refresh to update them.');
        sources = data.sources;
        return sources;
      }).catch(error => {
        sourceRequest = undefined;
        throw error;
      });
    }
    return sourceRequest;
  }
  function loadMosaic(): Promise<MosaicLibrary> {
    if (!mosaicRequest) {
      mosaicRequest = loadMosaicLibrary().catch(error => {
        mosaicRequest = undefined;
        throw error;
      });
    }
    return mosaicRequest;
  }
  async function showTileDetails(index: number, trigger = 'satellite-canvas', patchIndex?: number, openLocation = false) {
    openPanel('Satellite image', 'tile', trigger);
    await updateTileDetails(index, trigger, patchIndex, openLocation);
  }
  async function updateTileDetails(index: number, trigger = 'satellite-canvas', patchIndex?: number, openLocation = false) {
    const request = ++panelRequest;
    const scrollTop = panel.scrollTop;
    panel.dataset.sourceIndex = String(index);
    panel.dataset.imageryMode = imageryMode;
    if (patchIndex === undefined) delete panel.dataset.patchIndex;
    else panel.dataset.patchIndex = String(patchIndex);
    if (!panelContent.childElementCount) panelContent.append(paragraph('Opening satellite image…'));
    try {
      const [sceneList, library] = await Promise.all([
        loadSources(), patchIndex === undefined ? Promise.resolve(undefined) : loadMosaic(),
      ]);
      if (request !== panelRequest || activePanel !== 'tile') return;
      const scene = sceneList.find(source => source.index === index);
      if (!scene) throw new Error('Image details unavailable');
      const patch = library?.patches.find(candidate => candidate.index === patchIndex && candidate.sourceIndex === index);
      if (patchIndex !== undefined && !patch) throw new Error('Image crop unavailable');
      element('panel-title').textContent = scene.region.split(' · ')[0];
      panelContent.replaceChildren(buildTileDetails(scene, imageryMode, exploreLocation,
        library && patch ? { library, patch } : undefined));
      panel.scrollTop = scrollTop;
      if (openLocation) await exploreLocation(scene);
    } catch {
      if (request !== panelRequest || activePanel !== 'tile' || abort.signal.aborted) return;
      panelContent.replaceChildren(
        paragraph('The image details could not load. Please try again.'),
        button('Try again', () => { void showTileDetails(index, trigger, patchIndex, openLocation); }),
      );
    }
  }
  function inspectTile(clientX: number, clientY: number, openLocation = false): boolean {
    // A click or Enter may arrive before the pending camera animation frame.
    // Picking must use the final requested view, never the previous one.
    flushView();
    const selection = options.pickTile(clientX, clientY);
    if (selection) void showTileDetails(selection.atlasIndex, 'satellite-canvas', selection.patchIndex, openLocation);
    return !!selection;
  }
  function activateFile(file: VideoSource, time = 0, autoplay = false) {
    closePopovers();
    closePanel();
    returnToVideo();
    if (sameVideo(file, currentFile)) {
      video.currentTime = Math.min(time, Number.isFinite(video.duration) ? video.duration : time);
      if (autoplay) options.play();
    } else {
      options.openVideo(file, autoplay, time);
    }
  }
  function renderRecents() {
    openPanel('Recents', 'recents', 'recents-toggle');
    panelContent.append(paragraph(recentFiles.length ? 'Your videos from this visit.' : 'Your recently opened videos will appear here.'));
    const list = document.createElement('div');
    list.className = 'library-list';
    for (const file of recentFiles) {
      list.append(button(videoTitle(file), () => activateFile(file), 'library-item', sameVideo(file, currentFile) ? 'Currently open' : 'Open video'));
    }
    panelContent.append(list, button('Open a video', options.openPicker));
  }
  function renderSaved() {
    openPanel('Saved', 'saved', 'saved-toggle');
    panelContent.append(paragraph('Keep your favorite moments here for this visit.'));
    if (currentFile) panelContent.append(button('Save this moment', () => {
      if (!currentFile) return;
      savedMoments.push({ file: currentFile, time: video.currentTime });
      renderSaved();
    }));
    const list = document.createElement('div');
    list.className = 'library-list';
    for (const moment of [...savedMoments].reverse()) {
      list.append(button(videoTitle(moment.file), () => activateFile(moment.file, moment.time), 'library-item', `Saved at ${formatTime(moment.time)}`));
    }
    if (!savedMoments.length) list.append(paragraph(currentFile ? 'Find a moment you love, then save it above.' : 'Open a video to start saving moments.'));
    panelContent.append(list);
  }
  function renderMenu() {
    openPanel('Google Maps', 'menu', 'menu-toggle');
    panelContent.append(
      paragraph('A different view of your sound.'),
      button('Open a video', options.openPicker, 'library-item', 'Play a video from your device'),
      button('Your saved moments', renderSaved, 'library-item'),
      button('Recently opened', renderRecents, 'library-item'),
      button('Layers & visual settings', () => { returnToVideo(); closePanel(); togglePopover('settings-panel', 'layers-toggle'); }, 'library-item'),
      button('Fullscreen', options.toggleFullscreen, 'library-item'),
      paragraph('Your original music plays as every frame becomes a mosaic of satellite imagery. Your video stays on your device.'),
    );
  }
  async function renderGallery() {
    openPanel('Explore the Earth', 'gallery', 'streetview-toggle');
    const request = panelRequest;
    panelContent.append(paragraph('The real places inside every frame. Explore the Sentinel-2 imagery that makes up your view.'));
    try {
      await loadSources();
    } catch {
      if (activePanel === 'gallery' && request === panelRequest) panelContent.append(paragraph('The imagery details could not load. Try again in a moment.'));
      return;
    }
    const library = await loadMosaic();
    if (activePanel !== 'gallery' || request !== panelRequest) return;
    const gallery = document.createElement('div');
    gallery.className = 'satellite-gallery';
    const includedSources = new Set<number>(getImageryMode(imageryMode).sourceIndices);
    for (const source of sources.filter(scene => includedSources.has(scene.index))) {
      const link = document.createElement('button');
      link.className = 'satellite-place';
      link.type = 'button';
      const patch = library.patches.find(candidate => candidate.sourceIndex === source.index);
      link.addEventListener('click', () => { void showTileDetails(source.index, 'streetview-toggle', patch?.index); });
      link.title = `${source.region} · Explore this satellite image`;
      const swatch = document.createElement('div');
      swatch.className = 'satellite-swatch';
      swatch.style.backgroundPosition = `${(source.index % 4) / 3 * 100}% ${Math.floor(source.index / 4) / 3 * 100}%`;
      const label = document.createElement('span'); label.textContent = source.region;
      link.append(swatch, label); gallery.append(link);
    }
    panelContent.append(gallery);
  }

  function paintSearchResults() {
    const query = search.value.trim().toLowerCase();
    thumbnails.reset();
    searchResults.replaceChildren();
    const available = [...libraryVideos, ...recentFiles.filter(file => file instanceof File)];
    const matches = available.filter(file => file.name.toLowerCase().includes(query));
    if (!matches.length) searchResults.append(paragraph(libraryLoading && !libraryLoaded ? 'Loading videos…'
      : query ? 'No matching videos.' : 'Your video folder is empty.'));
    for (const file of matches) {
      const result = button(videoTitle(file), () => {
        search.value = ''; activateFile(file, 0, true);
      }, 'search-result video-search-result');
      result.prepend(thumbnails.create(file));
      searchResults.append(result);
    }
    if (libraryError) {
      searchResults.append(paragraph('The video folder could not load.'));
      searchResults.append(button('Try again', () => { void refreshVideoLibrary(); }, 'search-result'));
    }
    searchResults.append(button('Upload a video', options.openPicker, 'search-result'));
  }
  async function refreshVideoLibrary() {
    if (libraryLoading) return;
    let changed = !libraryLoaded;
    const hadError = libraryError;
    libraryLoading = true;
    libraryError = false;
    if (!searchResults.hidden && (changed || hadError)) paintSearchResults();
    try {
      const next = await loadVideoLibrary(abort.signal);
      changed ||= next.length !== libraryVideos.length || next.some((file, index) =>
        file.url !== libraryVideos[index]?.url || file.name !== libraryVideos[index]?.name || file.thumbnailUrl !== libraryVideos[index]?.thumbnailUrl);
      libraryVideos = next;
      libraryLoaded = true;
      thumbnails.preload(libraryVideos);
    } catch {
      if (!abort.signal.aborted) libraryError = true;
    } finally {
      libraryLoading = false;
      if (!abort.signal.aborted) paintChooser();
      // Preserve result nodes during routine refreshes. Replacing a pressed
      // button before pointerup swallows its click and prevents autoplay.
      if (!abort.signal.aborted && !searchResults.hidden && (changed || libraryError)) paintSearchResults();
    }
  }
  function renderSearch(refresh = false) {
    closePopovers('search-results');
    searchResults.hidden = false;
    element('search-button').setAttribute('aria-expanded', 'true');
    paintSearchResults();
    if (refresh || !libraryLoaded) void refreshVideoLibrary();
  }
  element('search-form').addEventListener('submit', (event) => { event.preventDefault(); renderSearch(true); }, eventOptions);
  search.addEventListener('input', () => renderSearch(), eventOptions);
  search.addEventListener('focus', () => renderSearch(true), eventOptions);
  search.addEventListener('click', () => renderSearch(true), eventOptions);
  search.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (searchResults.hidden) renderSearch(true);
    searchResults.querySelector<HTMLButtonElement>('.video-search-result')?.focus();
  }, eventOptions);
  bind('menu-toggle', () => activePanel === 'menu' ? closePanel() : renderMenu());
  bind('saved-toggle', () => activePanel === 'saved' ? closePanel() : renderSaved());
  bind('recents-toggle', () => activePanel === 'recents' ? closePanel() : renderRecents());
  bind('streetview-toggle', () => { if (activePanel === 'gallery') closePanel(); else void renderGallery(); });
  const pegman = setupPegmanDrag({
    player, canvas, button: element<HTMLButtonElement>('streetview-toggle'),
    enabled: () => !locationMap.isActive,
    onPickup: () => { closePanel(false); closePopovers(); },
    onDrop: (x, y) => inspectTile(x, y, true),
  });
  bind('panel-close', () => { closePanel(); lastTrigger?.focus(); });
  bind('layers-toggle', () => { returnToVideo(); closePanel(); togglePopover('settings-panel', 'layers-toggle'); });
  bind('settings-close', () => { closePopovers(); element('layers-toggle').focus(); });
  bind('profile-toggle', () => togglePopover('profile-menu', 'profile-toggle'));
  bind('profile-close', () => { closePopovers(); element('profile-toggle').focus(); });
  bind('apps-toggle', () => togglePopover('apps-menu', 'apps-toggle'));

  function selectImageryMode(mode: ImageryMode, announce = true) {
    returnToVideo();
    imageryMode = mode;
    const active = getImageryMode(mode);
    // All collections share the preloaded atlas. This call is synchronous and
    // changes only shader sampling, preserving the currently selected cell.
    const selectedTile = options.setImageryMode(mode);
    player.dataset.imageryMode = mode;
    canvas.dataset.imageryMode = mode;
    for (const control of document.querySelectorAll<HTMLButtonElement>('button[data-imagery-mode]')) {
      control.setAttribute('aria-pressed', String(control.dataset.imageryMode === mode));
    }
    element('active-imagery-label').textContent = active.label;
    element('active-imagery-description').textContent = active.description;
    if (announce) element('imagery-status').textContent = `${active.label} imagery selected.`;
    if (activePanel === 'tile') {
      const previousIndex = Number(panel.dataset.sourceIndex);
      const index = selectedTile?.atlasIndex ?? (active.sourceIndices.some(index => index === previousIndex)
        ? previousIndex : active.sourceIndices[0]);
      void updateTileDetails(index, lastTrigger?.id ?? 'satellite-canvas', selectedTile?.patchIndex);
    } else if (activePanel === 'gallery') {
      void renderGallery();
    }
  }

  document.addEventListener('click', (event) => {
    const mode = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-imagery-mode]')?.dataset.imageryMode;
    if (isImageryMode(mode)) selectImageryMode(mode);
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action) {
      closePopovers();
      if (action === 'upload') options.openPicker();
      if (action === 'settings') { returnToVideo(); closePanel(); togglePopover('settings-panel', 'layers-toggle'); }
      if (action === 'save') renderSaved();
      if (action === 'recents') renderRecents();
      if (action === 'fullscreen') options.toggleFullscreen();
    }
  }, eventOptions);
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target as HTMLElement).closest('#settings-panel, #layers-toggle, #profile-menu, #profile-toggle, #apps-menu, #apps-toggle, #search-form, #search-results')) closePopovers();
  }, eventOptions);

  function flushView() {
    if (viewFrame) cancelAnimationFrame(viewFrame);
    viewFrame = 0;
    if (!locationMap.isActive) {
      element('zoom-level').textContent = `${Math.round(view.zoom * 100)}%`;
      element<HTMLButtonElement>('zoom-in').disabled = view.zoom >= 4;
      element<HTMLButtonElement>('zoom-out').disabled = view.zoom <= 1;
    }
    canvas.dataset.zoom = String(view.zoom);
    canvas.dataset.pan = `${view.x},${view.y}`;
    if (appliedView && appliedView.zoom === view.zoom && appliedView.x === view.x && appliedView.y === view.y) return;
    appliedView = { ...view };
    options.setView(appliedView);
  }
  function applyView() {
    // Trackpad momentum can continue after reaching a zoom/pan limit. Keep
    // optional texture work deferred even if the clamped camera stays equal.
    options.onViewInput();
    view.zoom = Math.max(1, Math.min(4, view.zoom));
    const bound = .5 * (1 - 1 / view.zoom);
    view.x = Math.max(-bound, Math.min(bound, view.x));
    view.y = Math.max(-bound, Math.min(bound, view.y));
    // Wheel/trackpad and drag events can arrive several times per display
    // frame. Accumulate every input, then draw only the latest camera once.
    if (!viewFrame) viewFrame = requestAnimationFrame(flushView);
  }
  bind('zoom-in', () => changeZoom(1));
  bind('zoom-out', () => changeZoom(-1));
  bind('locate-button', () => {
    if (locationMap.isActive) { locationMap.recenter(); return; }
    Object.assign(view, { zoom: 1, x: 0, y: 0 }); applyView();
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    view.zoom *= Math.exp(-event.deltaY * 0.0015);
    applyView();
  }, { ...eventOptions, passive: false });
  canvas.addEventListener('dblclick', () => { view.zoom *= 1.25; applyView(); }, eventOptions);
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragged: false };
    canvas.setPointerCapture(event.pointerId);
  }, eventOptions);
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!pointer.dragged && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 6) return;
    pointer.dragged = true;
    canvas.classList.add('is-panning');
    const bounds = canvas.getBoundingClientRect();
    view.x -= (event.clientX - pointer.x) / bounds.width / view.zoom;
    view.y += (event.clientY - pointer.y) / bounds.height / view.zoom;
    pointer.x = event.clientX; pointer.y = event.clientY;
    applyView();
  }, eventOptions);
  canvas.addEventListener('pointerup', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const click = !pointer.dragged && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 6;
    pointer = undefined;
    canvas.classList.remove('is-panning');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (click) inspectTile(event.clientX, event.clientY);
  }, eventOptions);
  for (const name of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, () => { pointer = undefined; canvas.classList.remove('is-panning'); }, eventOptions);
  }
  canvas.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    inspectTile(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }, eventOptions);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (locationMap.isActive && panel.hidden) { returnToVideo(); return; }
      closePopovers(); closePanel(); lastTrigger?.focus(); return;
    }
    if ((event.target as HTMLElement).closest('input, textarea, button, a, select, [contenteditable], #location-map') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault(); changeZoom(event.key === '-' ? -1 : 1);
    }
  }, eventOptions);
  applyView();
  selectImageryMode(DEFAULT_IMAGERY_MODE, false);
  void refreshVideoLibrary();
  // Parse the large source manifest before the first tile click, keeping the
  // pointer interaction focused on GPU picking and panel presentation.
  window.setTimeout(() => { void loadSources().catch(() => undefined); }, 5000);

  return {
    onVideoOpened(file: VideoSource) {
      if (chooser.open) { chooser.close(); element('play-toggle').focus(); }
      pegman.cancel();
      returnToVideo();
      currentFile = file;
      const existing = recentFiles.findIndex(entry => sameVideo(entry, file));
      if (existing >= 0) recentFiles.splice(existing, 1);
      recentFiles.unshift(file);
      if (recentFiles.length > 10) recentFiles.pop();
      thumbnails.preload([file, ...libraryVideos]);
      closePanel(); closePopovers();
      search.value = '';
      Object.assign(view, { zoom: 1, x: 0, y: 0 });
      applyView();
    },
    dispose() { pegman.dispose(); abort.abort(); cancelAnimationFrame(viewFrame); locationMap.dispose(); },
  };
}
