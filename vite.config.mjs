import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { scanVideoLibrary, serveLibraryVideo } from './scripts/video-library.mjs';

const directory = fileURLToPath(new URL('./public/videos', import.meta.url));
const manifest = async () => JSON.stringify({ videos: await scanVideoLibrary(directory) });

export default defineConfig({
  // Refresh the catalog on search instead of reloading a playing page when an
  // MP4 is copied, renamed, or removed in Finder.
  server: { watch: { ignored: [`${directory}/**`] } },
  plugins: [{
    name: 'folder-video-library',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.startsWith('/videos/')) {
          try { await serveLibraryVideo(request, response, next, directory); }
          catch (error) { next(error); }
          return;
        }
        if (request.url?.split('?')[0] !== '/video-library.json') return next();
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        try { response.end(await manifest()); }
        catch (error) {
          server.config.logger.error(`Unable to read video folder: ${error.message}`);
          response.statusCode = 500;
          response.end(JSON.stringify({ error: 'Video library unavailable' }));
        }
      });
    },
    async transformIndexHtml() {
      const videos = await scanVideoLibrary(directory);
      return [
        // Discover opening thumbnails before downloading/executing the app.
        ...videos.slice(0, 6).filter(video => video.thumbnailUrl).map(video => ({
          tag: 'link', attrs: { rel: 'preload', as: 'image', href: video.thumbnailUrl, fetchpriority: 'high' }, injectTo: 'head',
        })),
        { tag: 'script', attrs: { id: 'initial-video-library', type: 'application/json' },
          children: JSON.stringify({ videos }).replace(/</g, '\\u003c'), injectTo: 'head' },
      ];
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'video-library.json', source: await manifest() });
    },
  }],
});
