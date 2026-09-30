/** The media element owns time. This class only observes and paints decoded frames. */
export class MediaClock {
  private frameCallback: number | undefined;
  private animationFrame: number | undefined;
  private disposed = false;
  private lastPaintedTime = -1;
  private readonly events = new AbortController();
  private readonly hasVideoFrameCallback: boolean;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly paint: (video: HTMLVideoElement, mediaTime: number) => void,
    private readonly updateControls: () => void,
  ) {
    this.hasVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const options = { signal: this.events.signal };
    for (const event of ['loadeddata', 'seeked', 'pause', 'ended']) {
      video.addEventListener(event, () => this.redraw(), options);
    }
    video.addEventListener('play', () => this.schedule(), options);
    video.addEventListener('loadeddata', () => this.schedule(), options);
    video.addEventListener('emptied', () => { this.lastPaintedTime = -1; }, options);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.redraw();
        this.schedule();
      }
    }, options);
    this.schedule();
  }

  /** Redraw the current decoded frame after seeking, resizing, or visual edits. */
  redraw(): void {
    if (this.disposed) return;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !this.video.seeking) {
      this.draw(this.video.currentTime);
    }
    this.updateControls();
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
  }

  private draw(mediaTime: number): void {
    this.paint(this.video, mediaTime);
    this.lastPaintedTime = mediaTime;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.hasVideoFrameCallback) {
      if (this.frameCallback !== undefined) return;
      this.frameCallback = this.video.requestVideoFrameCallback((_now, metadata) => {
        this.frameCallback = undefined;
        // No queue or synthetic frame counter: slow rendering simply misses frames.
        if (!this.video.seeking && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          this.draw(metadata.mediaTime);
        }
        this.updateControls();
        this.schedule();
      });
    } else {
      if (this.animationFrame !== undefined || this.video.paused || this.video.ended) return;
      this.animationFrame = requestAnimationFrame(() => {
        this.animationFrame = undefined;
        if (!this.video.seeking && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && this.video.currentTime !== this.lastPaintedTime) {
          this.draw(this.video.currentTime);
        }
        this.updateControls();
        this.schedule();
      });
    }
  }
}
