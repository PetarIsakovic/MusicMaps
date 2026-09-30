import { readdir, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Fresh filesystem reads avoid Vite's startup-only public-file cache. */
export async function serveLibraryVideo(request, response, next, directory) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (!pathname.startsWith('/videos/')) return next();
  let name;
  try { name = decodeURIComponent(pathname.slice('/videos/'.length)); }
  catch { response.statusCode = 400; response.end(); return; }
  const isThumbnail = /\.mp4\.jpg$/i.test(name);
  if (!/\.mp4$/i.test(name) && !isThumbnail) return next();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405; response.setHeader('Allow', 'GET, HEAD'); response.end(); return;
  }
  if (name.split('/').some(part => !part || part.startsWith('.')) || /[\\\0]/.test(name)) {
    response.statusCode = 404; response.end(); return;
  }
  let path, info;
  try {
    path = await realpath(resolve(directory, name));
    const root = await realpath(directory);
    if (!path.startsWith(root + sep)) throw new Error('Outside video folder');
    info = await stat(path);
    if (!info.isFile() || !info.size) throw new Error('Video unavailable');
  } catch { response.statusCode = 404; response.end(); return; }
  response.setHeader('Content-Type', isThumbnail ? 'image/jpeg' : 'video/mp4');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', isThumbnail && new URL(request.url, 'http://localhost').searchParams.has('v')
    ? 'public, max-age=31536000, immutable' : 'no-store');
  let start = 0, end = info.size - 1;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    } else start = info.size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      response.statusCode = 416;
      response.setHeader('Content-Range', `bytes */${info.size}`);
      response.end(); return;
    }
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  response.setHeader('Content-Length', end - start + 1);
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', error => response.destroy(error));
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/** Index real MP4 files only; subfolders are included without following symlinks. */
export async function scanVideoLibrary(directory, prefix = '') {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const videos = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const name = prefix + entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) videos.push(...await scanVideoLibrary(path, `${name}/`));
    else if (entry.isFile() && /\.mp4$/i.test(entry.name)) {
      let info;
      try { info = await stat(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.size) continue;
      const version = `${Math.trunc(info.mtimeMs).toString(36)}-${info.size}`;
      const video = { name, url: `/videos/${name.split('/').map(encodeURIComponent).join('/')}?v=${version}` };
      try {
        const thumbnail = await stat(`${path}.jpg`);
        if (thumbnail.isFile() && thumbnail.size) {
          video.thumbnailUrl = `/videos/${`${name}.jpg`.split('/').map(encodeURIComponent).join('/')}?v=${Math.trunc(thumbnail.mtimeMs).toString(36)}-${thumbnail.size}`;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      videos.push(video);
    }
  }
  return videos.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
}
