import type { VideoSource } from './video-library';
import { icon } from './map-shell';

/** Decode a still with a separate, silent element; never seek the playing video. */
function captureThumbnail(source: VideoSource, signal: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(undefined); return; }
    const video = document.createElement('video');
    const url = source instanceof File ? URL.createObjectURL(source) : source.url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    let finished = false;
    const finish = (image?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      video.onloadedmetadata = video.onseeked = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      if (source instanceof File) URL.revokeObjectURL(url);
      resolve(image);
    };
    const cancel = () => finish();
    const timeout = window.setTimeout(cancel, 15000);
    signal.addEventListener('abort', cancel, { once: true });
    video.onerror = cancel;
    video.onloadedmetadata = () => {
      // Skip opening black frames, while also supporting very short clips.
      video.currentTime = Math.min(2, Number.isFinite(video.duration) ? video.duration / 4 : 0.1);
    };
    video.onseeked = () => {
      try {
        if (!video.videoWidth || !video.videoHeight) { finish(); return; }
        const canvas = document.createElement('canvas');
        canvas.width = 192; canvas.height = 108;
        const context = canvas.getContext('2d')!;
        const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        context.fillStyle = '#202124';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        finish(canvas.toDataURL('image/jpeg', 0.82));
      } catch { finish(); }
    };
    video.src = url;
  });
}

const STORAGE_KEY = 'musicmaps-video-thumbnails-v1';
const CACHE_LIMIT = 100;

/** Warm the first results before search opens; prioritize visible rows thereafter. */
export function createVideoThumbnails(root: HTMLElement, signal: AbortSignal) {
  const cache = new Map<File | string, string>();
  // Versioned library URLs invalidate thumbnails when a file changes. Uploaded
  // Files stay in memory only; private-browsing/storage limits are non-fatal.
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-CACHE_LIMIT)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
        && entry[1].startsWith('data:image/jpeg;base64,') && entry[1].length < 100000) {
        cache.set(entry[0], entry[1]);
      }
    }
  } catch { /* Thumbnails can still be generated without persistent storage. */ }
  const sources = new WeakMap<Element, VideoSource>();
  let queue: HTMLImageElement[] = [];
  let backgroundQueue: VideoSource[] = [];
  let running = false;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      queue.push(entry.target as HTMLImageElement);
    }
    void drain();
  }, { root });

  async function drain() {
    if (running) return;
    running = true;
    try {
      while ((queue.length || backgroundQueue.length) && !signal.aborted) {
        const image = queue.shift();
        if (image && !image.isConnected) continue;
        const source = image ? sources.get(image)! : backgroundQueue.shift()!;
        const key = source instanceof File ? source : source.url;
        const cached = cache.get(key);
        const thumbnail = cached ?? await captureThumbnail(source, signal);
        if (!thumbnail || signal.aborted) continue;
        cache.set(key, thumbnail);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        if (!cached && typeof key === 'string') {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...cache].filter(([id]) => typeof id === 'string'))); }
          catch { /* Keep the memory cache if storage is unavailable or full. */ }
        }
        if (image) {
          image.src = thumbnail;
          image.classList.add('is-loaded');
        }
      }
    } finally { running = false; }
  }

  signal.addEventListener('abort', () => { observer.disconnect(); queue = []; backgroundQueue = []; cache.clear(); }, { once: true });
  return {
    preload(videos: VideoSource[]) {
      for (const source of videos.slice(0, 12)) {
        if (!(source instanceof File) && source.thumbnailUrl) {
          const image = new Image();
          image.src = source.thumbnailUrl;
        }
      }
      // Cover the initial dropdown and nearby scroll positions without decoding
      // an entire large video folder during startup.
      backgroundQueue = videos.slice(0, 12).filter(source => (source instanceof File || !source.thumbnailUrl) && !cache.has(source instanceof File ? source : source.url));
      void drain();
    },
    reset() { observer.disconnect(); queue = []; },
    create(source: VideoSource, priority: 'high' | 'auto' = 'auto') {
      const wrapper = document.createElement('div');
      wrapper.className = 'video-result-thumbnail';
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.innerHTML = icon('play');
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'eager';
      image.decoding = 'async';
      image.fetchPriority = priority;
      image.width = 96; image.height = 54;
      wrapper.append(image);
      if (!(source instanceof File) && source.thumbnailUrl) {
        image.onload = () => image.classList.add('is-loaded');
        image.onerror = () => {
          image.onerror = null;
          sources.set(image, source);
          observer.observe(image);
        };
        image.src = source.thumbnailUrl;
        return wrapper;
      }
      const thumbnail = cache.get(source instanceof File ? source : source.url);
      if (thumbnail) { image.src = thumbnail; image.classList.add('is-loaded'); }
      else { sources.set(image, source); observer.observe(image); }
      return wrapper;
    },
  };
}
