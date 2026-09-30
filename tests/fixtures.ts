import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtureDirectory = resolve('tests/.fixtures');
export const musicalVideo = resolve(fixtureDirectory, 'test-music.mp4');
export const silentVideo = resolve(fixtureDirectory, 'test-silent.mp4');

export function ensureMediaFixtures() {
  mkdirSync(fixtureDirectory, { recursive: true });
  if (!existsSync(musicalVideo)) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', musicalVideo,
    ]);
  }
  if (!existsSync(silentVideo)) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', musicalVideo,
      '-c:v', 'copy', '-an', silentVideo,
    ]);
  }
}
