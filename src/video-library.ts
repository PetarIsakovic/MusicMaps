export type LibraryVideo = { name: string; url: string; thumbnailUrl?: string };
export type VideoSource = File | LibraryVideo;

export function sameVideo(first: VideoSource, second?: VideoSource): boolean {
  if (first instanceof File || second instanceof File) return first === second;
  return first.url === second?.url;
}

export async function loadVideoLibrary(signal: AbortSignal): Promise<LibraryVideo[]> {
  const initial = document.getElementById('initial-video-library');
  let data;
  if (initial) {
    // Consume once; subsequent search refreshes still discover folder changes.
    initial.remove();
    data = JSON.parse(initial.textContent ?? '{}');
  } else {
    const response = await fetch('/video-library.json', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Video library unavailable');
    data = await response.json();
  }
  if (!Array.isArray(data.videos)) throw new Error('Invalid video catalog');
  const seen = new Set<string>();
  return data.videos.filter((entry: unknown): entry is LibraryVideo => {
    if (!entry || typeof entry !== 'object' || !('name' in entry) || !('url' in entry)
      || typeof entry.name !== 'string' || typeof entry.url !== 'string') return false;
    try {
      const url = new URL(entry.url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/videos/') || !/\.mp4$/i.test(url.pathname)
        || seen.has(url.href)) return false;
      if ('thumbnailUrl' in entry && entry.thumbnailUrl !== undefined) {
        if (typeof entry.thumbnailUrl !== 'string') return false;
        const thumbnail = new URL(entry.thumbnailUrl, location.origin);
        if (thumbnail.origin !== location.origin || !thumbnail.pathname.startsWith('/videos/') || !/\.jpg$/i.test(thumbnail.pathname)) return false;
      }
      seen.add(url.href);
      return true;
    } catch { return false; }
  });
}
