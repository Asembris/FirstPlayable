import { expect, test } from '@playwright/test';
import recorded from '../../evidence/qloo/audition/recorded-2026-10-07.json';
import synthetic from '../../fixtures/qloo/audition/canonical.json';
import { auditContrast } from './support/contrast';
const radiohead = recorded.audiences[0]!.entity_id;
const kendrick = recorded.audiences[1]!.entity_id;
const lanternfold = synthetic.audiences[0]!.entity_id;
const juno = synthetic.audiences[1]!.entity_id;

/**
 * The default judge path is the recorded Qloo comparison: real Qloo
 * identities and affinities, replayed from `evidence/qloo/`, with no provider
 * call of any kind. The synthetic record is still reachable at
 * `?mode=synthetic` and still has to label itself as invented.
 */
test('recorded judge path uses zero API calls, switches reading and exposes real Qloo evidence', async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  page.on('request', (request) => { const url = request.url(); if (!url.startsWith(baseURL!) || new URL(url).pathname.startsWith('/api/')) unexpected.push(url); });
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/audition');
  await expect(page.getByRole('heading', { name: 'The Last Signal', exact: true })).toBeVisible();
  await expect(page.getByTestId('replay-label')).toHaveText('Recorded Qloo example · real Qloo evidence retrieved 2026-10-07 · no live calls');
  await expect(page.getByTestId('replay-mode')).toHaveText('Recorded Qloo example');
  const movies = page.getByTestId('panel-movie');
  const games = page.getByTestId('panel-videogame');
  const decision = page.getByTestId('audition-decision');
  await expect(decision).toContainText('fixed example question, no model call');
  await expect(page.getByTestId('decision-question')).toHaveText('Which movie comp should I foreground for Radiohead fans?');
  await expect(page.getByTestId('decision-answer')).toHaveText('For this audience signal, Moon is the clear lead among your confirmed movie comps.');
  await expect(page.getByTestId('decision-basis')).toContainText('the recorded Qloo audience affinity for Radiohead fans, retrieved 2026-10-07');
  await expect(page.getByTestId('decision-basis')).not.toContainText('synthetic');
  // Qloo's own numbers, ordered by this tool: two movie reversals, one game reversal.
  await expect(movies.locator('[data-verdict="reversal"]')).toHaveCount(2);
  await expect(games.locator('[data-verdict="reversal"]')).toHaveCount(1);
  await expect(games.locator('[data-verdict="holds"]')).toContainText('Outer Wilds / Mass Effect: same order');
  await expect(movies.locator('[data-verdict="close"]')).toContainText('close — no call');
  await expect(movies.getByTestId(`ranking-movie-${radiohead}`).getByTestId('ranked').first()).toContainText('affinity 0.928');
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`).getByTestId('top-status')).toHaveAttribute('data-status', 'close');
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`)).toContainText('no single lead');
  await page.getByRole('button', { name: 'Kendrick Lamar fans', exact: true }).click();
  await expect(movies.getByTestId(`ranking-movie-${kendrick}`)).toHaveAttribute('data-active', 'true');
  await expect(movies.getByTestId(`ranking-movie-${radiohead}`)).toHaveAttribute('data-active', 'false');
  await expect(movies.getByTestId(`ranking-movie-${kendrick}`).getByTestId('ranked').last()).toContainText('Position 1 → 3');
  // The prominent call follows the reading: same question, same recorded
  // capture, re-answered for Kendrick Lamar. Qloo's movie leader changes.
  await expect(decision).toHaveAttribute('data-audience', kendrick);
  await expect(page.getByTestId('decision-question')).toHaveText('Which movie comp should I foreground for Kendrick Lamar fans?');
  await expect(page.getByTestId('decision-answer')).toHaveText('For this audience signal, Arrival is the clear lead among your confirmed movie comps.');
  await expect(page.getByTestId('decision-basis')).toContainText('the recorded Qloo audience affinity for Kendrick Lamar fans, retrieved 2026-10-07');
  await expect(page.getByTestId('decision-answer')).not.toContainText('Moon');
  // The games panel is read for the same audience, and declines the call.
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`)).toHaveAttribute('data-active', 'true');
  await expect(games.getByTestId(`ranking-videogame-${kendrick}`).getByTestId('top-status')).toHaveAttribute('data-status', 'close');
  await expect(games.getByTestId(`ranking-videogame-${radiohead}`).getByTestId('top-status')).toHaveAttribute('data-status', 'clear');
  await expect(games.getByTestId(`ranking-videogame-${radiohead}`).getByTestId('ranked').first()).toContainText('Mass Effect');
  // Switching back restores the question the record actually asked.
  await page.getByRole('button', { name: 'Radiohead fans', exact: true }).click();
  await expect(decision).toHaveAttribute('data-audience', radiohead);
  await expect(page.getByTestId('decision-question')).toHaveText('Which movie comp should I foreground for Radiohead fans?');
  await expect(page.getByTestId('decision-answer')).toHaveText('For this audience signal, Moon is the clear lead among your confirmed movie comps.');
  await page.getByRole('button', { name: 'Kendrick Lamar fans', exact: true }).click();
  for (const domain of ['movie', 'videogame']) {
    const evidence = page.getByTestId(`evidence-${domain}`);
    await evidence.locator('summary').click();
    await expect(evidence.locator('summary')).toHaveText('Recorded Qloo evidence');
    await expect(evidence).toContainText('Recorded Qloo capture dated 2026-10-07');
    await expect(evidence).toContainText('Replayed locally; no provider calls');
    await expect(evidence).toContainText('filter.results.entities=');
    await expect(evidence.getByTestId('evidence-entity').first()).toContainText(`Qloo ${radiohead}`);
    await expect(evidence.getByTestId('evidence-request').first()).toContainText('recorded · 2026-10-07T12:15:');
    // Recorded mode may never be presented as invented, and never leaks the host.
    await expect(evidence).not.toContainText(/synthetic/i);
    await expect(evidence).not.toContainText('qloo.com');
    await expect(evidence).toContainText(radiohead);
    await expect(evidence).toContainText(kendrick);
  }
  expect(unexpected).toEqual([]);
});

test('the synthetic record stays reachable and still labels itself as invented', async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  page.on('request', (request) => { const url = request.url(); if (!url.startsWith(baseURL!) || new URL(url).pathname.startsWith('/api/')) unexpected.push(url); });
  await page.goto('/audition?mode=synthetic');
  await expect(page.getByTestId('replay-label')).toHaveText('Synthetic example · invented demonstration data · no live calls');
  await expect(page.getByTestId('replay-mode')).toHaveText('Synthetic example');
  await expect(page.getByTestId('decision-answer')).toHaveText('For this audience signal, Quiet Orbit is the clear lead among your confirmed movie comps.');
  await expect(page.getByTestId('decision-basis')).toContainText('synthetic saved affinities');
  await expect(page.getByTestId('decision-basis')).not.toContainText('Qloo audience affinity');
  const evidence = page.getByTestId('evidence-movie');
  await evidence.locator('summary').click();
  await expect(evidence.locator('summary')).toHaveText('Synthetic evidence');
  await expect(evidence).toContainText('Synthetic saved example dated 2026-01-15');
  await expect(evidence).toContainText('None of it was returned by Qloo');
  await expect(evidence.getByTestId('evidence-entity').first()).toContainText('synthetic entity id');
  await expect(evidence.getByTestId('evidence-request').first()).toContainText('Synthetic request record');
  // Synthetic mode must never present invented values as Qloo-returned or Qloo-identified.
  await expect(evidence).not.toContainText('Names come from the Qloo');
  await expect(evidence).not.toContainText('Qloo returned');
  await expect(evidence).not.toContainText(/Qloo [0-9A-F]{8}-/);
  await expect(evidence).toContainText(lanternfold);
  await expect(evidence).toContainText(juno);
  expect(unexpected).toEqual([]);
});

test('mobile recorded comparison keeps both audiences readable without overflow', async ({ page }) => {
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
  await page.getByTestId('replay-mode').click();
  await expect(page.getByTestId('audition-results')).toBeVisible();
  expect(attempts).toBe(2);
});

test('main landing routes to the recorded audition first and keeps the thesis and specimen', async ({ page, baseURL }) => {
  const api: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(baseURL!) || new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose the comps. Switch the audience. See what changes.');
  await expect(page.locator('.rt-landing__lede')).toContainText('Qloo’s taste data');
  await expect(page.getByTestId('rt-door-play')).toHaveAttribute('href', '/audition');
  await expect(page.getByTestId('rt-door-play')).toContainText('Recorded Qloo evidence · 2026-10-07');
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

test('mobile landing opens the recorded product without horizontal pan', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('rt-door-play').click();
  await expect(page.getByTestId('audition-results')).toBeVisible();
});
