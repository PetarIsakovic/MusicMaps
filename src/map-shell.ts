import { atlasPosition, DEFAULT_IMAGERY_MODE, getImageryMode, IMAGERY_MODES } from './imagery-modes';
import { MAP_ATTRIBUTION } from './imagery-collection';
import { MAX_DENSITY } from './mosaic-shaders';

const icons = {
  github: '<path fill="currentColor" stroke="none" d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.725-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.333-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.51 11.51 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  x: '<path fill="currentColor" stroke="none" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.9-9L.8 2h6.5l4.5 6.7L18.9 2ZM17.8 20h1.7L6.3 4H4.5l13.3 16Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  directions: '<path d="m10.6 2.8-8 8a1.7 1.7 0 0 0 0 2.4l8 8a1.7 1.7 0 0 0 2.4 0l8-8a1.7 1.7 0 0 0 0-2.4l-8-8a1.7 1.7 0 0 0-2.4 0Z" fill="currentColor" stroke="none"/><path d="M8 15v-5h7m-2.5-2.5L15 10l-2.5 2.5" stroke="white" stroke-width="1.9"/>',
  saved: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  recent: '<path d="M3.5 6.5V12H9M4 11a8 8 0 1 1 1.5 6.5M12 7v5l3 2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="1.5"/><path d="M11 5h2M11 19h2"/>',
  restaurants: '<path d="M5 3v7m3-7v7M2 3v6a3 3 0 0 0 6 0M5 12v9M17 3v18m0-18c-4 2-4 9 0 9"/>',
  hotels: '<path d="M3 5v15m18-10v10M3 16h18M3 9h6v7m0-7h9a3 3 0 0 1 3 3v4"/><circle cx="6" cy="9" r="2" fill="currentColor" stroke="none"/>',
  camera: '<path d="M8 5 9.5 3h5L16 5h4a1 1 0 0 1 1 1v13H3V6a1 1 0 0 1 1-1Z"/><circle cx="12" cy="12" r="4"/>',
  museum: '<path d="m2 9 10-7 10 7M4 8v13h16V8M8 18v-7l4 4 4-4v7"/>',
  transit: '<rect x="5" y="2" width="14" height="17" rx="3"/><path d="M5 11h14M8 19l-2 3m10-3 2 3M12 5v6M8 5h8"/><circle cx="8.5" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15" r="1" fill="currentColor" stroke="none"/>',
  pharmacy: '<path d="M4 6h16l-2 15H6ZM3 6h18M8 2h8v4M12 9v7m-3.5-3.5h7"/>',
  atm: '<path d="m1 16 2.5-8L6 16M2 13h3M8 8h6m-3 0v8M17 16V8l3 4 3-4v8" stroke-width="1.6"/>',
  apps: '<g fill="currentColor" stroke="none"><circle cx="5" cy="5" r="1.9"/><circle cx="12" cy="5" r="1.9"/><circle cx="19" cy="5" r="1.9"/><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/><circle cx="5" cy="19" r="1.9"/><circle cx="12" cy="19" r="1.9"/><circle cx="19" cy="19" r="1.9"/></g>',
  layers: '<path d="m12 3 10 7-10 7-10-7ZM2 15l10 7 10-7"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  compass: '<path d="m12 2 5 10H7Z" fill="#ea4335" stroke="none"/><path d="m12 22 5-10H7Z" fill="white" stroke="none"/>',
  chevrons: '<path d="m7 14 5-5 5 5m-10 5 5-5 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-6 6-6 12 0 18 6-6 6-12 0-18Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 5 6 9H3v6h3l5 4zM16 9l6 6m0-6-6 6"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  closeFullscreen: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  music: '<path d="M10 17V5l10-2v12M10 8l10-2"/><ellipse cx="6.5" cy="18" rx="3.5" ry="2.5"/><ellipse cx="16.5" cy="16" rx="3.5" ry="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".9" fill="currentColor" stroke="none"/>',
};

export const icon = (name: keyof typeof icons, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

const mapPreview = `<svg class="map-preview" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="#dce7d3"/><path d="M0 0h46l8 31-24 19L0 44ZM73 65l27-12v47H56Z" fill="#b6d4a3"/><path d="m76-8-5 31-25 15 8 20-5 16 6 34" fill="none" stroke="#a4cfda" stroke-width="12"/><path d="m-5 29 33 8 7 25 38 15 31-18M-3 79l39-17L75 22l28 8" fill="none" stroke="#fff" stroke-width="6"/><path d="M12-8 26 29l16 40 6 40" fill="none" stroke="#f8ebbd" stroke-width="6"/><path d="M12-8 26 29l16 40 6 40" fill="none" stroke="#fff" stroke-width="2"/></svg>`;

const categories = [
  ['restaurants', 'Restaurants'], ['hotels', 'Hotels'], ['camera', 'Things to do'],
  ['museum', 'Museums'], ['transit', 'Transit'], ['pharmacy', 'Pharmacies'], ['atm', 'ATMs'],
] as const;

function imageryOptions(inSettings = false): string {
  return IMAGERY_MODES.map(mode => `<button id="${inSettings ? 'settings-' : ''}mode-${mode.id}" class="${inSettings ? 'imagery-option' : 'imagery-button'}" type="button" data-imagery-mode="${mode.id}" aria-label="${mode.label} imagery" aria-pressed="${mode.id === DEFAULT_IMAGERY_MODE}" title="${mode.label} imagery"><span class="imagery-thumbnail" style="background-position:${atlasPosition(mode.previewIndex)}" aria-hidden="true"></span>${inSettings ? `<span class="imagery-option-label">${mode.label}</span>` : ''}</button>`).join('');
}

export function mapShell(): string {
  const initialImagery = getImageryMode(DEFAULT_IMAGERY_MODE);
  return `<main id="player" class="player is-empty" aria-label="Google Maps satellite video player">
    <video id="source-video" class="source-video" playsinline loop preload="auto" tabindex="-1" aria-hidden="true" disablepictureinpicture></video>
    <canvas id="satellite-canvas" tabindex="0" aria-controls="map-panel" aria-expanded="false" aria-label="Satellite reconstruction. Click a tile for its image and details, or press Enter to inspect the center."></canvas>
    <section id="location-view" hidden aria-label="Scene location"><div id="location-map" tabindex="0" role="region" aria-label="Satellite map. Drag to explore; scroll or double-click to zoom."></div></section>
    <section id="location-banner" class="floating-card" hidden aria-label="Photo location">
      <button id="back-to-video" class="scene-card-back" type="button">${icon('arrow')} Back to video</button>
      <div id="location-photo" class="scene-photo-frame" tabindex="0" role="button" aria-label="Open the selected photo location on the map" title="Double-click a feature to find it on the map"></div>
      <h1 id="location-title" class="scene-card-title"></h1>
      <div class="location-coordinate-row"><p id="location-coordinates" class="scene-coordinate-text"></p><button id="location-copy-coordinates" class="scene-copy" type="button" aria-label="Copy coordinates" title="Copy coordinates" hidden>${icon('copy')}</button></div>
      <span id="location-copy-status" class="sr-only" role="status"></span>
      <p id="location-map-status" role="status" aria-live="polite" hidden></p><button id="location-map-retry" type="button" hidden>Retry photo</button>
    </section>
    <dialog id="video-chooser" class="video-chooser" aria-label="Choose a video">
      <div class="chooser-content">
        <div id="chooser-videos" class="chooser-grid" aria-label="Demo videos"></div>
        <p id="chooser-status" class="chooser-status" role="status">Loading videos…</p>
        <button id="chooser-retry" class="chooser-retry" type="button" hidden>Try again</button>
        <button id="chooser-upload" class="chooser-upload" type="button">${icon('upload')} Upload a video</button>
      </div>
    </dialog>
    <input type="file" id="video-upload" accept="video/*,.mp4,.mov,.webm,.m4v,.ogv,.mkv" hidden />
    <nav class="map-rail" aria-label="Main navigation">
      <button id="menu-toggle" class="rail-menu round-button" aria-label="Menu" title="Menu" aria-expanded="false">${icon('menu')}</button>
      <div class="rail-primary">
        <button id="saved-toggle" class="rail-button" title="Saved videos">${icon('saved')}<span>Saved</span></button>
        <button id="recents-toggle" class="rail-button" title="Recent videos">${icon('recent')}<span>Recents</span></button>
      </div>
      <div class="rail-separator"></div>
      <a class="rail-button collection-button" href="https://github.com/PetarIsakovic/MusicMaps" target="_blank" rel="noopener noreferrer" title="View MusicMaps on GitHub"><span class="collection-thumbnail">${icon('music')}</span><span>Google<br />Maps</span></a>
      <div class="rail-bottom"><div class="rail-separator"></div><a id="get-app" class="rail-button" href="https://github.com/PetarIsakovic/MusicMaps" target="_blank" rel="noopener noreferrer" title="Get MusicMaps on GitHub">${icon('phone')}<span>Get app</span></a></div>
    </nav>
    <header class="map-header">
      <form id="search-form" class="map-search" role="search">
        <label class="sr-only" for="map-search">Search Google Maps</label>
        <input id="map-search" type="search" placeholder="Search Google Maps" autocomplete="off" spellcheck="false" />
        <button id="search-button" class="round-button search-button" type="submit" aria-label="Search" title="Search">${icon('search')}</button>
        <span class="search-divider"></span>
        <button id="upload-button" class="round-button directions-button" type="button" aria-label="Open a video" title="Open a video">${icon('directions')}</button>
      </form>
      <nav class="category-row" aria-label="Explore on Google Maps">
        ${categories.map(([name, label]) => `<a class="category-pill" href="https://www.google.com/maps/search/${encodeURIComponent(label)}/" target="_blank" rel="noopener noreferrer" title="Find ${label.toLowerCase()} on Google Maps">${icon(name)}<span>${label}</span></a>`).join('')}
      </nav>
      <div class="account-controls">
        <button id="apps-toggle" class="round-button apps-toggle" aria-label="Google Maps apps" title="Google Maps apps" aria-expanded="false">${icon('apps')}</button>
        <button id="profile-toggle" class="profile-button" aria-label="Petar Isakovic profile" title="Petar Isakovic" aria-expanded="false"><img src="/PetarIsakovicMainImage.png" alt="Petar Isakovic" /></button>
      </div>
    </header>
    <div id="search-results" class="search-results floating-card" hidden></div>
    <aside id="map-panel" class="map-panel floating-card" aria-labelledby="panel-title" hidden>
      <div class="panel-heading"><h2 id="panel-title">Google Maps</h2><button id="panel-close" class="round-button" aria-label="Close panel">${icon('close')}</button></div>
      <div id="panel-content" class="panel-content"></div>
    </aside>
    <div id="apps-menu" class="apps-menu floating-card" aria-label="Google Maps shortcuts" hidden>
      <button data-action="upload">${icon('upload')}<span>Open video</span></button>
      <button data-action="settings">${icon('layers')}<span>Layers</span></button>
      <button data-action="save">${icon('saved')}<span>Save video</span></button>
      <button data-action="recents">${icon('recent')}<span>Recents</span></button>
      <button data-action="fullscreen">${icon('fullscreen')}<span>Fullscreen</span></button>
      <a href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer">${icon('globe')}<span>Google Maps</span></a>
    </div>
    <div id="profile-menu" class="profile-menu floating-card" aria-label="Profile" hidden>
      <button id="profile-close" class="round-button profile-close" aria-label="Close profile">${icon('close')}</button>
      <div class="profile-sections">
        <div class="profile-identity"><img src="/PetarIsakovicMainImage.png" alt="" /><div><h2>Petar Isakovic</h2><p>@PetarIsakovic06</p></div></div>
        <a class="profile-social" href="https://x.com/PetarIsakovic06" target="_blank" rel="noopener noreferrer"><span class="profile-social-icon">${icon('x')}</span><span><strong>Follow me on X</strong><small>@PetarIsakovic06</small></span></a>
        <!-- Replace this placeholder with a link when the repository URL is available. -->
        <a id="profile-github" class="profile-social" href="https://github.com/PetarIsakovic/MusicMaps" target="_blank" rel="noopener noreferrer"><span class="profile-social-icon">${icon('github')}</span><span><strong>GitHub repo</strong><small>PetarIsakovic/MusicMaps</small></span></a>
      </div>
      <div class="profile-footer">x.com/PetarIsakovic06</div>
    </div>
    <div class="canvas-topline" aria-hidden="true"><span id="canvas-dimensions" class="sr-only">LIVE CANVAS</span></div>
    <div id="media-message" class="media-message" role="status" aria-live="polite" hidden></div>
    <div id="imagery-status" class="sr-only" role="status" aria-live="polite"></div>
    <div id="drop-overlay" class="drop-overlay">${icon('upload')}<strong>Drop your video here</strong><span>See your music from a new perspective.</span></div>
    <button id="layers-toggle" class="layers-button" aria-label="Layers and visual settings" title="Layers and visual settings" aria-expanded="false">${mapPreview}<span>${icon('layers')}Layers</span></button>
    <section id="settings-panel" class="settings-panel floating-card" aria-label="Visual settings" hidden>
      <div class="panel-heading"><h2>Layers</h2><button id="settings-close" class="round-button" aria-label="Close visual settings">${icon('close')}</button></div>
      <div class="imagery-picker" role="group" aria-label="Imagery type">${imageryOptions(true)}</div>
      <div class="imagery-description"><strong id="active-imagery-label">${initialImagery.label}</strong><p id="active-imagery-description">${initialImagery.description}</p></div>
      <div class="setting"><label for="density">Video detail <output id="density-value" for="density">260</output></label><input id="density" type="range" min="24" max="${MAX_DENSITY}" value="260" step="1" /></div>
      <div class="setting"><label for="organic">Organic shape <output id="organic-value">70%</output></label><input id="organic" type="range" min="0" max="1" value="0.7" step="0.01" /><div class="range-hints"><span>Geometric</span><span>Fluid</span></div></div>
      <div class="setting"><label for="contrast">Matching contrast <output id="contrast-value">1.00×</output></label><input id="contrast" type="range" min="0.7" max="1.6" value="1" step="0.01" /><div class="range-hints"><span>Soft</span><span>Defined</span></div></div>
    </section>
    <section class="transport floating-card" aria-label="Video playback controls">
      <div class="detail-control">
        <div class="detail-row"><label for="detail-density">Video detail</label><input id="detail-density" type="range" min="24" max="${MAX_DENSITY}" value="260" step="1" /><output id="detail-density-value" for="detail-density">260</output></div>
      </div>
      <div class="sr-only"><span id="track-name">Your next discovery</span><span id="playback-status">WAITING FOR A VIDEO</span></div>
      <label class="sr-only" for="seek">Seek</label><input id="seek" class="seek" type="range" min="0" max="0" step="0.01" value="0" disabled />
      <div class="control-row">
        <button id="play-toggle" class="icon-button play-button" aria-label="Play" title="Play (Space)" disabled>${icon('play')}</button>
        <div class="time-display"><span id="current-time">0:00</span><span class="time-divider">/</span><span id="duration">0:00</span></div>
        <div class="volume-controls"><button id="mute-toggle" class="icon-button" aria-label="Mute" title="Mute (M)">${icon('volume')}</button><label class="sr-only" for="volume">Volume</label><input type="range" id="volume" min="0" max="1" value="1" step="0.01" /></div>
        <span class="control-divider"></span><button id="fullscreen-toggle" class="icon-button" aria-label="Enter fullscreen" title="Fullscreen (F)">${icon('fullscreen')}</button>
      </div>
    </section>
    <div class="map-controls" aria-label="Map view controls">
      <button id="locate-button" class="map-control" aria-label="Center satellite view" title="Center satellite view">${icon('locate')}</button>
      <div class="zoom-controls"><button id="zoom-in" class="map-control" aria-label="Zoom in" title="Zoom in">${icon('plus')}</button><button id="zoom-out" class="map-control" aria-label="Zoom out" title="Zoom out">${icon('minus')}</button></div>
    </div>
    <div class="map-extras"><button id="streetview-toggle" class="pegman-button" aria-label="Drag onto a satellite tile to explore its location, or click to explore imagery" title="Drag onto a tile to explore its location · Click to explore imagery" aria-controls="map-panel" aria-expanded="false"><span class="pegman-dock-figure" aria-hidden="true"></span></button><div class="imagery-strip" role="group" aria-label="Imagery type">${imageryOptions()}</div><button class="imagery-expand" data-action="settings" aria-label="Layers and visual settings" title="Layers and visual settings">${icon('chevrons')}</button></div>
    <div class="map-wordmark" aria-label="Google Maps">Google Maps</div>
    <footer class="map-footer"><span class="imagery-credit">${MAP_ATTRIBUTION}</span><a href="/satellite-scenes.json" target="_blank" rel="noopener noreferrer">Image credits</a><span class="map-scale"><span id="zoom-level">1× view</span><i></i></span></footer>
  </main>`;
}
