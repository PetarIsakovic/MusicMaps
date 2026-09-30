import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Prevent a successful-looking deployment containing LFS pointer text as media.
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.isFile() && (await stat(path)).size < 1024) {
      if ((await readFile(path, 'utf8')).startsWith('version https://git-lfs.github.com/spec/v1')) {
        throw new Error(`Missing Git LFS media: ${path}. Run git lfs pull. On Netlify set GIT_LFS_ENABLED=true and GIT_LFS_FETCH_INCLUDE=*.mp4,*.jpg in the UI, then redeploy with a cleared cache.`);
      }
    }
  }
}
await check('public');
