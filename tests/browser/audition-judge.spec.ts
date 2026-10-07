import { expect, test } from '@playwright/test';
import record from '../../fixtures/qloo/audition/canonical.json';
import { auditContrast } from './support/contrast';
const radiohead = record.audiences[0]!.entity_id;
const kendrick = record.audiences[1]!.entity_id;

test('saved judge path uses zero API calls, switches reading and exposes real evidence', async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  page.on('request', (request) => { const url = request.url(); if (!url.startsWith(baseURL!) || new URL(url).pathname.startsWith('/api/')) unexpected.push(url); });
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/audition');
  await expect(page.getByRole('heading', { name: 'The Last Signal', exact: true })).toBeVisible();
  const movies = page.getByTestId('panel-movie');
  const games = page.getByTestId('panel-videogame');
  await expect(movies.locator('[data-verdict="reversal"]')).toHaveCount(2);
  await expect(games.locator('[data-verdict="reversal"]')).toHaveCount(1);
  await expect(games.locator('[data-verdict="holds"]')).toContainText('Outer Wilds / Mass Effect: same order');
  await expect(movies.locator('[data-verdict="close"]')).toContainText('close — no call');
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`).getByTestId('top-status')).toHaveAttribute('data-status', 'close');
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`)).toContainText('no single lead');
  await page.getByRole('button', { name: 'Kendrick Lamar fans', exact: true }).click();
  await expect(movies.getByTestId(`ranking-movie-${kendrick}`)).toHaveAttribute('data-active', 'true');
  await expect(movies.getByTestId(`ranking-movie-${radiohead}`)).toHaveAttribute('data-active', 'false');
  await expect(movies.getByTestId(`ranking-movie-${kendrick}`).getByTestId('ranked').last()).toContainText('Position 1 → 3');
  for (const domain of ['movie', 'videogame']) {
    const evidence = page.getByTestId(`evidence-${domain}`);
    await evidence.locator('summary').click();
    await expect(evidence).toContainText('Replayed locally; no provider calls');
    await expect(evidence).toContainText('filter.results.entities=');
    await expect(evidence).toContainText('2026-10-07');
    await expect(evidence).toContainText(radiohead);
    await expect(evidence).toContainText(kendrick);
  }
  expect(unexpected).toEqual([]);
});

test('mobile saved comparison keeps both audiences readable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/audition');
  await page.getByRole('button', { name: 'Kendrick Lamar fans', exact: true }).click();
  const columns = page.getByTestId('panel-movie').locator('.rt-audition__column');
  const first = await columns.nth(0).boundingBox(); const second = await columns.nth(1).boundingBox();
  expect(first!.x + first!.width).toBeLessThanOrEqual(second!.x);
  expect(second!.x + second!.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('panel-videogame').locator('[data-verdict="close"]')).toContainText('close — no call');
  await page.getByTestId('evidence-videogame').locator('summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('first interaction waits for session establishment and its cookie', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let sessionStarted = false; let interpreted = false;
  await page.route('**/api/session', async (route) => {
    sessionStarted = true; await waiting;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'set-cookie': 'readiness=ready; Path=/; SameSite=Lax' }, body: JSON.stringify({ established: true }) });
  });
  await page.route('**/api/audition/interpret', async (route) => {
    interpreted = true;
    expect(route.request().headers()['cookie']).toContain('readiness=ready');
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'REQUEST_REFUSED', message: 'Readiness verified.', retryable: false }) });
  });
  await page.goto('/audition');
  expect(sessionStarted).toBe(false);
  await page.getByTestId('try-own').click();
  await expect(page.getByRole('status')).toHaveText('Preparing your session…');
  await expect(page.getByTestId('audition-send')).toBeDisabled();
  expect(interpreted).toBe(false);
  release();
  await expect(page.getByTestId('audition-send')).toBeEnabled();
  await page.getByTestId('audition-send').click();
  await expect(page.getByTestId('audition-failure')).toContainText('Readiness verified');
  expect(interpreted).toBe(true);
});

test('failed session keeps live actions disabled and can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/session', (route) => {
    attempts++;
    return route.fulfill({ status: attempts === 1 ? 503 : 200, contentType: 'application/json', body: JSON.stringify(attempts === 1 ? { code: 'PERSISTENCE_UNAVAILABLE', message: 'Session unavailable.', retryable: true } : { established: true }) });
  });
  await page.goto('/audition?mode=live');
  await expect(page.getByTestId('audition-failure')).toContainText('Session unavailable');
  await expect(page.getByTestId('audition-send')).toBeDisabled();
  await page.getByTestId('session-retry').click();
  await expect(page.getByTestId('audition-send')).toBeEnabled();
  await page.getByRole('button', { name: 'Saved example', exact: true }).click();
  await expect(page.getByTestId('audition-results')).toBeVisible();
  expect(attempts).toBe(2);
});

test('main landing routes to saved audition first and keeps the thesis and real specimen', async ({ page, baseURL }) => {
  const api: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(baseURL!) || new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose the comps. Switch the audience. See what changes.');
  await expect(page.locator('.rt-landing__lede')).toContainText('Qloo’s taste data');
  await expect(page.getByTestId('rt-door-play')).toHaveAttribute('href', '/audition');
  await expect(page.getByTestId('rt-door-create')).toHaveAttribute('href', '/audition?mode=live');
  const specimen = page.getByTestId('rt-specimen');
  await expect(specimen).toContainText('Moon / Arrival: reversed');
  await expect(specimen.locator('.rt-specimen__cell').nth(0)).toContainText('1. Moon');
  await expect(specimen.locator('.rt-specimen__cell').nth(1)).toContainText('1. Arrival');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(page.getByTestId('rt-door-play')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/audition$/);
  await expect(page.getByTestId('audition-results')).toBeVisible();
  expect(api).toEqual([]);
});


for (const width of [1440, 390]) {
  test(`judge comparison text remains readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/audition');
    const failures = await auditContrast(page);
    expect(failures).toEqual([]);
  });
}

test('mobile landing opens the saved product without horizontal pan', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('rt-door-play').click();
  await expect(page.getByTestId('audition-results')).toBeVisible();
});
