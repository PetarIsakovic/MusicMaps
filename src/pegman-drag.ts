type PegmanOptions = {
  player: HTMLElement;
  canvas: HTMLCanvasElement;
  button: HTMLButtonElement;
  enabled: () => boolean;
  onPickup: () => void;
  onDrop: (x: number, y: number) => boolean;
};

// The cursor is the landing point, just like a direct click on the canvas.
// Lift only the decorative figure; never offset the marker or tile lookup.

/** Pointer-driven chrome only. Picking happens once, at the final drop point. */
export function setupPegmanDrag(options: PegmanOptions) {
  const { player, canvas, button } = options;
  const events = new AbortController();
  const listener = { signal: events.signal };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const flyer = document.createElement('div');
  flyer.id = 'pegman-drag';
  flyer.className = 'pegman-flyer';
  flyer.hidden = true;
  flyer.setAttribute('aria-hidden', 'true');
  flyer.innerHTML = `<span class="pegman-shadow"></span><span class="pegman-target"></span><span class="pegman-swing"><span class="pegman-figure"></span></span>`;
  const figure = flyer.querySelector<HTMLElement>('.pegman-figure')!;
  // Decode both sheets before pickup; changing poses never starts a network request.
  for (const name of ['dangling', 'dropping']) {
    const image = new Image();
    image.src = `/pegman/${name}-2x.png`;
    void image.decode().catch(() => {});
  }
  const announcement = document.createElement('span');
  announcement.className = 'sr-only';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  player.append(flyer, announcement);

  let pointer: { id: number; startX: number; startY: number; x: number; y: number; dragging: boolean } | undefined;
  let frame = 0;
  let cleanupTimer = 0;
  let returnAnimation: Animation | undefined;
  let suppressClick = false;
  let lastTime = 0;
  let lastX = 0;
  let angle = 0;
  let angularVelocity = 0;
  let horizontalSpeed = 0;
  let lastPose = -1;
  let lastValid: boolean | undefined;

  function canDrop(x: number, y: number): boolean {
    // Ignore controls above the canvas; the drop marker itself never intercepts hits.
    return options.enabled() && document.elementFromPoint(x, y) === canvas;
  }

  function clearAnimation(): void {
    clearTimeout(cleanupTimer);
    cleanupTimer = 0;
    returnAnimation?.cancel();
    returnAnimation = undefined;
    flyer.hidden = true;
    button.classList.remove('pegman-away');
    delete flyer.dataset.phase;
  }

  function positionMarker(x: number, y: number): void {
    // Pointer events can arrive ahead of RAF, especially while rendering video.
    // Move the landing point immediately; only the decorative sway is smoothed.
    flyer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function updatePointer(event: PointerEvent): void {
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!pointer.dragging && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= 5) beginDrag();
    if (pointer.dragging) positionMarker(pointer.x, pointer.y);
  }

  function draw(time: number): void {
    frame = 0;
    if (!pointer?.dragging) return;
    const dt = Math.min(.032, Math.max(.001, (time - lastTime) / 1000));
    const speed = (pointer.x - lastX) / Math.max(1, time - lastTime);
    // Smooth event bursts without making the grabbed point lag behind the mouse.
    horizontalSpeed += (speed - horizontalSpeed) * (1 - Math.exp(-dt / .045));
    const target = Math.max(-80, Math.min(80, horizontalSpeed * 38));
    if (reducedMotion.matches) angle = angularVelocity = 0;
    else {
      // Only the hanging body has inertia, through the original 17 directional
      // poses. Frame 8 hangs upright; frame 17 is a shadow, never a body pose.
      angularVelocity += ((target - angle) * 190 - angularVelocity * 20) * dt;
      angle += angularVelocity * dt;
    }
    lastTime = time;
    lastX = pointer.x;
    positionMarker(pointer.x, pointer.y);
    const pose = Math.max(0, Math.min(16, 8 - Math.round(angle / 10)));
    if (pose !== lastPose) {
      figure.style.backgroundPositionY = `${-pose * 75}px`;
      flyer.dataset.pose = String(pose);
      lastPose = pose;
    }
    const valid = canDrop(pointer.x, pointer.y);
    flyer.dataset.valid = String(valid);
    if (valid !== lastValid) {
      announcement.textContent = valid ? 'Release to open this satellite tile.' : 'Move onto a satellite tile. Escape cancels.';
      lastValid = valid;
    }
    // No canvas drawing, GPU readbacks, or media operations while dragging.
    frame = requestAnimationFrame(draw);
  }

  function beginDrag(): void {
    if (!pointer) return;
    pointer.dragging = true;
    suppressClick = true;
    options.onPickup();
    button.classList.add('pegman-away');
    button.dataset.dragging = 'true';
    player.classList.add('is-dragging-pegman');
    flyer.hidden = false;
    flyer.dataset.phase = 'drag';
    lastValid = undefined;
    angle = angularVelocity = horizontalSpeed = 0;
    lastPose = -1;
    lastTime = performance.now();
    lastX = pointer.x;
    draw(lastTime);
  }

  function finish(drop: boolean, animate = true): void {
    const current = pointer;
    if (!current) return;
    pointer = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    button.classList.remove('pegman-pressed');
    delete button.dataset.dragging;
    player.classList.remove('is-dragging-pegman');
    if (button.hasPointerCapture(current.id)) button.releasePointerCapture(current.id);
    if (!current.dragging) return;
    // Pointerup can beat RAF: always pick the final position and displayed frame.
    const dropY = current.y;
    positionMarker(current.x, dropY);
    const accepted = drop && canDrop(current.x, dropY) && options.onDrop(current.x, dropY);
    announcement.textContent = accepted ? 'Opening satellite location.' : 'Drag cancelled.';
    if (!animate || reducedMotion.matches) { clearAnimation(); return; }
    if (accepted) {
      figure.style.backgroundPositionY = '';
      flyer.dataset.phase = 'drop';
      cleanupTimer = window.setTimeout(clearAnimation, 330);
    } else {
      const home = button.getBoundingClientRect();
      flyer.dataset.phase = 'return';
      figure.style.backgroundPositionY = '-600px';
      const homeX = home.x + home.width / 2;
      const homeY = home.y + home.height / 2;
      returnAnimation = flyer.animate([
        { transform: `translate3d(${current.x}px, ${dropY}px, 0) scale(1)`, opacity: 1 },
        { transform: `translate3d(${(current.x + homeX) / 2}px, ${Math.min(dropY, homeY) - 30}px, 0) scale(.95)`, opacity: 1, offset: .4 },
        { transform: `translate3d(${homeX}px, ${homeY + 20}px, 0) scale(.8)`, opacity: 0 },
      ], { duration: 320, easing: 'cubic-bezier(.25,.65,.35,1)', fill: 'forwards' });
      cleanupTimer = window.setTimeout(clearAnimation, 330);
    }
  }

  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || pointer || !options.enabled()) return;
    clearAnimation();
    suppressClick = false;
    pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, dragging: false };
    button.classList.add('pegman-pressed');
    button.setPointerCapture(event.pointerId);
    button.focus({ preventScroll: true });
  }, listener);
  // Capture can be released independently of the mouse/touch gesture. Track
  // the active pointer at document level so that does not discard a valid drop.
  document.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    updatePointer(event);
    if (pointer.dragging) event.preventDefault();
  }, { ...listener, capture: true, passive: false });
  document.addEventListener('pointerup', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    // A fast release may be the first event outside the pickup threshold.
    updatePointer(event);
    finish(true);
  }, { ...listener, capture: true });
  document.addEventListener('pointercancel', event => {
    if (pointer?.id === event.pointerId) finish(false);
  }, { ...listener, capture: true });
  // Captured drags generate a click on the dock. Preserve only real clicks and
  // keyboard activation, so a successful drop cannot open the gallery over it.
  button.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { ...listener, capture: true });
  button.addEventListener('dragstart', event => event.preventDefault(), listener);
  document.addEventListener('keydown', event => {
    if (!pointer || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(false);
    button.focus({ preventScroll: true });
  }, { ...listener, capture: true });
  window.addEventListener('blur', () => finish(false, false), listener);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false, false); }, listener);
  document.addEventListener('fullscreenchange', () => finish(false, false), listener);

  return {
    cancel() { finish(false, false); clearAnimation(); },
    dispose() {
      finish(false, false);
      clearAnimation();
      events.abort();
      flyer.remove();
      announcement.remove();
    },
  };
}
