import './style.css';
import { MediaClock } from './media-clock';
import { SatelliteRenderer, type VisualSettings } from './satellite-renderer';

import { icon, mapShell } from './map-shell';
import { setupMapControls } from './map-controls';
import { DEFAULT_IMAGERY_MODE, type ImageryMode } from './imagery-modes';
import type { VideoSource } from './video-library';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = mapShell();

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const video = element<HTMLVideoElement>('source-video');
const canvas = element<HTMLCanvasElement>('satellite-canvas');
const player = element<HTMLElement>('player');
const upload = element<HTMLInputElement>('video-upload');
const playButton = element<HTMLButtonElement>('play-toggle');
const seek = element<HTMLInputElement>('seek');
const volume = element<HTMLInputElement>('volume');
const muteButton = element<HTMLButtonElement>('mute-toggle');
const fullscreenButton = element<HTMLButtonElement>('fullscreen-toggle');
const message = element<HTMLElement>('media-message');
const status = element<HTMLElement>('playback-status');
const events = new AbortController();
const eventOptions = { signal: events.signal };
let objectURL: string | undefined;
let activeSource: VideoSource | undefined;
let sourceEvents = new AbortController();
let renderer: SatelliteRenderer | undefined;
let rendererFailed = false;
let buffering = false;
let frameRequested = 0;
let lastPlaying: boolean | undefined;
let lastMuted: boolean | undefined;
let mapControls: ReturnType<typeof setupMapControls> | undefined;
let imageryMode: ImageryMode = DEFAULT_IMAGERY_MODE;

const settings: VisualSettings = { density: 260, organic: 0.7, contrast: 1 };

function showMessage(text: string, isError = false): void {
  message.textContent = text;
  message.hidden = !text;
  message.classList.toggle('is-error', isError);
}

function formatTime(time: number): string {
  const seconds = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty('--progress', `${max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0}%`);
}

function updateControls(): void {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const playing = !video.paused && !video.ended;
  const muted = video.muted || video.volume === 0;
  playButton.disabled = !duration;
  seek.disabled = !duration;
  seek.max = String(duration);
  seek.value = String(video.currentTime);
  seek.setAttribute('aria-valuetext', `${formatTime(video.currentTime)} of ${formatTime(duration)}`);
  paintRange(seek);
  element('current-time').textContent = formatTime(video.currentTime);
  element('duration').textContent = formatTime(duration);
  if (lastPlaying !== playing) {
    playButton.innerHTML = icon(playing ? 'pause' : 'play');
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playButton.title = `${playing ? 'Pause' : 'Play'} (Space)`;
    player.classList.toggle('is-playing', playing);
    lastPlaying = playing;
  }
  if (lastMuted !== muted) {
    muteButton.innerHTML = icon(muted ? 'muted' : 'volume');
    muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    muteButton.setAttribute('aria-pressed', String(muted));
    player.classList.toggle('is-muted', muted);
    lastMuted = muted;
  }
  volume.value = String(video.volume);
  paintRange(volume);
  status.textContent = !activeSource ? 'WAITING FOR A VIDEO' : video.error ? 'UNABLE TO PLAY' :
    video.seeking ? 'SEEKING' : buffering && playing ? 'BUFFERING' : playing ? 'LIVE RECONSTRUCTION' :
      video.ended ? 'FINISHED' : duration ? 'READY WHEN YOU ARE' : 'LOADING';
}

try {
  renderer = new SatelliteRenderer(canvas);
  renderer.setSettings(settings);
} catch (error) {
  rendererFailed = true;
  showMessage(`Satellite visuals need WebGL enabled in your browser. ${error instanceof Error ? error.message : ''}`, true);
}

const mediaClock = new MediaClock(video, (source, mediaTime) => {
  if (!renderer || rendererFailed) return;
  try {
    renderer.render(source, mediaTime);
    canvas.dataset.mediaTime = String(mediaTime);
  } catch (error) {
    rendererFailed = true;
    showMessage('The satellite view could not render. Your audio is still playing; reload to restore the view.', true);
    console.error(error);
  }
}, updateControls);

// A resize or settings edit schedules a paint only. It never loads, seeks, or plays media.
function requestRedraw(): void {
  if (frameRequested) return;
  frameRequested = requestAnimationFrame(() => {
    frameRequested = 0;
    renderer?.resize();
    element('canvas-dimensions').textContent = `${Math.round(player.clientWidth)} × ${Math.round(player.clientHeight)}`;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) mediaClock.redraw();
    else if (!rendererFailed) renderer?.renderIdle?.();
  });
}

if (renderer) {
  renderer.loadAtlas().then(requestRedraw).catch(() => {
    showMessage('The satellite imagery could not load. Reload the page to try again.', true);
  });
}
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  rendererFailed = true;
  showMessage('Restoring the satellite view. Your audio continues playing.');
}, eventOptions);
canvas.addEventListener('webglcontextrestored', () => {
  try {
    renderer?.dispose();
    renderer = new SatelliteRenderer(canvas);
    renderer.setSettings(settings);
    renderer.setImageryMode(imageryMode);
    rendererFailed = false;
    renderer.loadAtlas().then(() => { showMessage(''); requestRedraw(); }).catch(() => {
      showMessage('The satellite imagery could not reload. Your audio continues playing.', true);
    });
  } catch {
    showMessage('The satellite view could not recover. Reload the page to restore it.', true);
  }
}, eventOptions);

function openVideo(file: VideoSource, autoplay = false, startTime = 0): void {
  const looksLikeVideo = (file instanceof File && file.type.startsWith('video/')) || /\.(mp4|mov|m4v|webm|ogv|mkv|avi)$/i.test(file.name);
  if (!looksLikeVideo) {
    showMessage('Choose a video file, such as MP4, MOV, or WebM.', true);
    return;
  }
  const previousURL = objectURL;
  objectURL = file instanceof File ? URL.createObjectURL(file) : undefined;
  activeSource = file;
  sourceEvents.abort();
  sourceEvents = new AbortController();
  if (startTime > 0) video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(startTime, Number.isFinite(video.duration) ? video.duration : startTime);
  }, { once: true, signal: sourceEvents.signal });
  // This is the only source replacement path. Visual operations never come here.
  video.pause();
  video.src = file instanceof File ? objectURL! : file.url;
  video.load();
  if (previousURL) URL.revokeObjectURL(previousURL);
  buffering = false;
  canvas.removeAttribute('data-media-time');
  element('track-name').textContent = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  element('track-name').title = file.name;
  player.classList.remove('is-empty');
  mapControls?.onVideoOpened(file);
  showMessage(rendererFailed ? 'Satellite visuals are unavailable. Enable WebGL and reload to restore the view.' : 'Opening your video…', rendererFailed);
  updateControls();
  // Start within the selection/upload event, preserving the user's gesture.
  if (autoplay) void playVideo();
}

element('upload-button').addEventListener('click', () => upload.click(), eventOptions);
upload.addEventListener('change', () => {
  if (upload.files?.[0]) openVideo(upload.files[0], true);
  upload.value = '';
}, eventOptions);

async function playVideo(): Promise<void> {
  const requestedSource = video.getAttribute('src');
  try {
    await video.play();
    if (!rendererFailed && video.getAttribute('src') === requestedSource) showMessage('');
  } catch (error) {
    if (video.getAttribute('src') !== requestedSource) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    showMessage('Playback could not start. Try Play again, or choose a video your browser supports.', true);
  }
}
async function togglePlayback(): Promise<void> {
  if (!activeSource || !video.duration) return;
  if (!video.paused) { video.pause(); return; }
  await playVideo();
}
playButton.addEventListener('click', () => { void togglePlayback(); }, eventOptions);
seek.addEventListener('input', () => {
  if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, Number(seek.value)));
  updateControls();
}, eventOptions);
volume.addEventListener('input', () => {
  video.volume = Number(volume.value);
  if (video.volume > 0) video.muted = false;
}, eventOptions);
muteButton.addEventListener('click', () => {
  if (video.volume === 0) { video.volume = 0.5; video.muted = false; }
  else video.muted = !video.muted;
}, eventOptions);

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch {
    showMessage('Fullscreen is unavailable in this browser. You can still resize the window.');
  }
}
fullscreenButton.addEventListener('click', () => { void toggleFullscreen(); }, eventOptions);
if (!document.fullscreenEnabled) fullscreenButton.hidden = true;
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === player;
  fullscreenButton.innerHTML = icon(active ? 'closeFullscreen' : 'fullscreen');
  fullscreenButton.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  requestRedraw();
}, eventOptions);

const detailInputs = ['density', 'detail-density'].map(id => element<HTMLInputElement>(id));
function updateDetail(value: number): void {
  settings.density = value;
  for (const input of detailInputs) {
    input.value = String(value);
    input.setAttribute('aria-valuetext', `${value} detail; higher values use more, smaller satellite images`);
    element(`${input.id}-value`).textContent = String(value);
    paintRange(input);
  }
}
updateDetail(settings.density);
for (const input of detailInputs) {
  input.addEventListener('input', () => {
    updateDetail(Number(input.value));
    renderer?.setSettings(settings);
    requestRedraw();
  }, eventOptions);
}

for (const key of ['organic', 'contrast'] as const) {
  const input = element<HTMLInputElement>(key);
  paintRange(input);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    element(`${key}-value`).textContent = key === 'organic' ? `${Math.round(settings[key] * 100)}%` : `${settings[key].toFixed(2)}×`;
    paintRange(input);
    renderer?.setSettings(settings);
    requestRedraw();
  }, eventOptions);
}

for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'seeking', 'seeked']) {
  video.addEventListener(event, updateControls, eventOptions);
}
for (const event of ['loadeddata', 'canplay', 'playing', 'seeked']) {
  video.addEventListener(event, () => {
    buffering = false;
    if (!rendererFailed && !video.error) showMessage('');
    updateControls();
  }, eventOptions);
}
video.addEventListener('waiting', () => { buffering = true; updateControls(); }, eventOptions);
video.addEventListener('error', () => {
  showMessage('This video could not be decoded. Try an MP4 with H.264 video and AAC audio, or a WebM file.', true);
  updateControls();
}, eventOptions);

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('#location-map') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
  if (target.closest('input, button, a, textarea, select, [contenteditable]') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'Space' || event.key.toLowerCase() === 'k') { event.preventDefault(); void togglePlayback(); }
  if (event.key.toLowerCase() === 'm') muteButton.click();
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
  if (activeSource && Number.isFinite(video.duration) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5)));
  }
}, eventOptions);

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; player.classList.add('is-dragging'); }
}, eventOptions);
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) player.classList.remove('is-dragging');
}, eventOptions);
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }, eventOptions);
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  player.classList.remove('is-dragging');
  if (event.dataTransfer?.files[0]) openVideo(event.dataTransfer.files[0], true);
}, eventOptions);

mapControls = setupMapControls({
  video, canvas, openVideo, play: () => { void playVideo(); }, openPicker: () => upload.click(),
  // Camera changes draw the cached mosaic. A media redraw here would upload
  // and match the same video frame again for every wheel or pointer event.
  setView: (view) => renderer?.setView(view),
  onViewInput: () => renderer?.deferDetailForInteraction(),
  pickTile: (x, y) => renderer?.pickTile(x, y) ?? null,
  clearSelection: () => renderer?.clearSelection(),
  setImageryMode: (mode) => {
    imageryMode = mode;
    renderer?.setImageryMode(mode);
    requestRedraw();
    return renderer?.getSelection() ?? null;
  },
  toggleFullscreen: () => { void toggleFullscreen(); },
});

const resizeObserver = new ResizeObserver(requestRedraw);
resizeObserver.observe(player);
window.addEventListener('resize', requestRedraw, eventOptions);
updateControls();
requestRedraw();

// Preserve playback on bfcache navigation; clean up only when the document is discarded.
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  mediaClock.dispose();
  mapControls?.dispose();
  events.abort();
  sourceEvents.abort();
  resizeObserver.disconnect();
  cancelAnimationFrame(frameRequested);
  renderer?.dispose();
  video.removeAttribute('src');
  video.load();
  if (objectURL) URL.revokeObjectURL(objectURL);
});
