import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureMediaFixtures, musicalVideo } from './fixtures';

test.beforeAll(ensureMediaFixtures);

async function upload(page: Page) {
  await page.locator('#video-upload').setInputFiles(musicalVideo);
  await expect.poll(() => page.locator('#source-video').evaluate(
    (video: HTMLVideoElement) => video.readyState,
  )).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#play-toggle')).toBeEnabled();
}

async function setRange(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((input: HTMLInputElement, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function expectRenderedTime(page: Page, time: number) {
  await expect.poll(async () => {
    const actual = await page.locator('#satellite-canvas').getAttribute('data-media-time');
    return actual === null ? Infinity : Math.abs(Number(actual) - time);
  }).toBeLessThan(0.1);
}

test('the Maps shell uses Petar’s photo and keeps playback reachable on a phone', async ({ page }) => {
  await page.goto('/');
  const avatar = page.locator('#profile-toggle img');
  await expect(avatar).toHaveAttribute('src', '/PetarIsakovicMainImage.png');
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#profile-toggle').click();
  await expect(page.locator('#profile-menu')).toBeVisible();
  await expect(page.locator('#profile-menu')).toContainText('Petar');
  const follow = page.locator('#profile-menu a');
  await expect(follow).toHaveText('Follow me on X@PetarIsakovic06');
  await expect(follow).toHaveAttribute('href', 'https://x.com/PetarIsakovic06');
  await expect(follow).toHaveAttribute('target', '_blank');
  await expect(page.locator('#profile-menu [data-action="upload"]')).toHaveCount(0);
  await page.locator('#profile-menu').screenshot({ path: '/tmp/musicmaps-profile.png' });
  await page.getByRole('button', { name: 'Close profile', exact: true }).click();
  await expect(page.locator('#profile-menu')).toBeHidden();
  await expect(page.locator('#profile-toggle')).toBeFocused();
  await page.locator('#profile-toggle').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#profile-menu')).toBeHidden();
  await upload(page);
  await expectRenderedTime(page, 0);
  await page.screenshot({ path: '/tmp/maps-desktop.png' });

  for (const width of [900, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const credit = page.locator('.map-footer .imagery-credit');
    await expect(credit).toBeVisible();
    await expect(credit.locator('a[href*="creativecommons.org/licenses/"]')).toBeInViewport();
    const layout = await page.evaluate(() => {
      const footer = document.querySelector<HTMLElement>('.map-footer')!;
      const credit = footer.querySelector<HTMLElement>('.imagery-credit')!;
      const footerBounds = footer.getBoundingClientRect();
      const creditBounds = credit.getBoundingClientRect();
      return {
        footerLeft: footerBounds.left, footerRight: footerBounds.right, footerTop: footerBounds.top,
        creditLeft: creditBounds.left, creditRight: creditBounds.right,
        footerOverflow: footer.scrollWidth - footer.clientWidth,
        creditOverflow: credit.scrollWidth - credit.clientWidth,
        transportBottom: document.querySelector('.transport')!.getBoundingClientRect().bottom,
      };
    });
    expect(layout.footerLeft, `Footer at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(layout.footerRight).toBeLessThanOrEqual(width);
    expect(layout.creditLeft).toBeGreaterThanOrEqual(layout.footerLeft);
    expect(layout.creditRight).toBeLessThanOrEqual(layout.footerRight);
    expect(layout.footerOverflow).toBeLessThanOrEqual(1);
    expect(layout.creditOverflow).toBeLessThanOrEqual(1);
    expect(layout.transportBottom, `Credit must stay below playback controls at ${width}px`)
      .toBeLessThanOrEqual(layout.footerTop);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('#play-toggle')).toBeVisible();
  const bounds = await page.locator('#play-toggle').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate(
    (video: HTMLVideoElement) => video.currentTime,
  )).toBeGreaterThan(0.2);
  await page.screenshot({ path: '/tmp/maps-mobile.png' });
});

test('zoom, pan and recenter leave the same audio source playing without media interruptions', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate(
    (video: HTMLVideoElement) => video.currentTime,
  )).toBeGreaterThan(0.2);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { mapsSource?: HTMLVideoElement; mapsInterruptions?: string[] };
    state.mapsSource = video;
    state.mapsInterruptions = [];
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange']) {
      video.addEventListener(event, () => state.mapsInterruptions!.push(event));
    }
    return { source: video.currentSrc, time: video.currentTime };
  });
  const canvas = page.locator('#satellite-canvas');
  await page.locator('#zoom-in').click();
  await expect(canvas).toHaveAttribute('data-zoom', '1.25');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await expect(canvas).not.toHaveAttribute('data-pan', '0,0');
  await page.locator('#locate-button').click();
  await expect(canvas).toHaveAttribute('data-zoom', '1');
  await expect(canvas).toHaveAttribute('data-pan', '0,0');
  await expect.poll(() => page.locator('#source-video').evaluate(
    (video: HTMLVideoElement) => video.currentTime,
  )).toBeGreaterThan(before.time + 0.2);
  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { mapsSource?: HTMLVideoElement; mapsInterruptions?: string[] };
    return { source: video.currentSrc, sameElement: video === state.mapsSource, paused: video.paused,
      rate: video.playbackRate, interruptions: state.mapsInterruptions,
      visualLag: Math.abs(video.currentTime - Number(document.querySelector<HTMLElement>('#satellite-canvas')!.dataset.mediaTime)) };
  });
  expect(after).toMatchObject({ source: before.source, sameElement: true, paused: false, rate: 1, interruptions: [] });
  expect(after.visualLag).toBeLessThan(0.2);
});

test('Layers changes the paused satellite frame without seeking the video', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await setRange(page, '#seek', 2.5);
  await expectRenderedTime(page, 2.5);
  await page.waitForLoadState('networkidle');
  const canvas = page.locator('#satellite-canvas');
  const screenshotOptions = {
    style: '#player *:not(#satellite-canvas) { visibility: hidden !important; } #satellite-canvas { visibility: visible !important; }',
  };
  const before = await canvas.screenshot(screenshotOptions);
  await page.locator('#layers-toggle').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#density')).toBeVisible();
  await setRange(page, '#density', 35);
  await expect(page.locator('#density-value')).toContainText('35');
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-panel')).toBeHidden();
  const after = await canvas.screenshot(screenshotOptions);
  expect(after.equals(before), 'Changing density should redraw actual satellite pixels').toBe(false);
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: 2.5 });
  await expectRenderedTime(page, 2.5);
});

test('the visible detail slider changes the mosaic from 24 to 260, stays synced with Layers, and preserves media', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await setRange(page, '#seek', 2.5);
  await expectRenderedTime(page, 2.5);
  const detail = page.locator('#detail-density');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute('min', '24');
  await expect(detail).toHaveAttribute('max', '260');
  await expect(page.locator('#settings-panel')).toBeHidden();
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    Object.assign(window, { detailVideo: video, detailInterruptions: [] });
    for (const type of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange'])
      video.addEventListener(type, () => (window as any).detailInterruptions.push(type));
    return { source: video.currentSrc, time: video.currentTime };
  });
  await detail.focus();
  await page.keyboard.press('Home');
  await expect(detail).toHaveValue('24');
  await expect(page.locator('#density')).toHaveValue('24');
  const canvas = page.locator('#satellite-canvas');
  const screenshotOptions = {
    style: '#player *:not(#satellite-canvas) { visibility: hidden !important; } #satellite-canvas { visibility: visible !important; }',
  };
  const lowDetail = await canvas.screenshot(screenshotOptions);
  // Screenshot-only visibility styling blurs focused controls.
  await detail.focus();
  await page.keyboard.press('End');
  await expect(detail).toHaveValue('260');
  await expect(page.locator('#density')).toHaveValue('260');
  await expect(page.locator('#detail-density-value')).toHaveText('260');
  await expect(page.locator('#density-value')).toHaveText('260');
  const highDetail = await canvas.screenshot(screenshotOptions);
  expect(highDetail.equals(lowDetail), 'Detail must alter actual satellite image cells').toBe(false);
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: before.time });
  await page.locator('#layers-toggle').click();
  await setRange(page, '#density', 112);
  await expect(detail).toHaveValue('112');
  await expect(page.locator('#detail-density-value')).toHaveText('112');
  await page.locator('#settings-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  const sliderBounds = (await detail.boundingBox())!;
  expect(sliderBounds.x).toBeGreaterThanOrEqual(0);
  expect(sliderBounds.x + sliderBounds.width).toBeLessThanOrEqual(390);
  for (const selector of ['#layers-toggle', '.map-extras', '.map-controls']) {
    const bounds = (await page.locator(selector).boundingBox())!;
    expect(bounds.y + bounds.height, `${selector} must stay above the detail slider on a phone`).toBeLessThan(sliderBounds.y);
  }
  await page.locator('#play-toggle').click();
  await detail.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(detail).toHaveValue('25');
  await expect(page.locator('#density')).toHaveValue('25');
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(before.time + .2);
  expect(await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { same: video === (window as any).detailVideo, source: video.currentSrc, paused: video.paused,
      rate: video.playbackRate, interruptions: (window as any).detailInterruptions };
  })).toEqual({ same: true, source: before.source, paused: false, rate: 1, interruptions: [] });
});

test('Saved restores a moment and local search renders file names as safe text', async ({ page }) => {
  await page.goto('/');
  const name = 'Petar <img src=x onerror=alert(1)>.mp4';
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.locator('#video-upload').setInputFiles({ name, mimeType: 'video/mp4', buffer: readFileSync(musicalVideo) });
  await expect(page.locator('#play-toggle')).toBeEnabled();
  await setRange(page, '#seek', 3.25);
  await expectRenderedTime(page, 3.25);
  const source = await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentSrc);
  await page.locator('#saved-toggle').click();
  await page.getByRole('button', { name: 'Save this moment', exact: true }).click();
  await expect(page.locator('#panel-content')).toContainText('Saved at 0:03');
  await page.locator('#panel-close').click();
  await setRange(page, '#seek', 1);
  await expectRenderedTime(page, 1);
  await page.locator('#saved-toggle').click();
  await page.locator('#panel-content .library-item').click();
  await expectRenderedTime(page, 3.25);
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentSrc)).toBe(source);

  await page.locator('#map-search').fill('petar');
  await expect(page.locator('#search-results')).toBeVisible();
  await expect(page.locator('#search-results').getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('#search-results img')).toHaveCount(0);
  await page.locator('#search-results').getByText(name, { exact: true }).click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) =>
    !video.paused && video.currentTime < 1.5)).toBe(true);
  await page.locator('#recents-toggle').click();
  await expect(page.locator('#panel-content').getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('#panel-content img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});
