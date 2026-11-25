/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { createClassificationDetails } from '../../src/content/classification-details';
import type { ClassificationDetails } from '../../src/types';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([undefined, null, 42, true, {}])('uses the original cutoff for non-string textSent=%j', async textSent => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const details = createClassificationDetails({ textSent, scores: [{ label: 'birds', score: 0.5 }] } as unknown as ClassificationDetails, null);
  document.body.append(details);
  expect(details.querySelector('li')?.textContent).toBe('birds · 0.50 · needs 0.29 · Matched');
  if (textSent == null) expect(details.querySelector('pre')?.textContent).toBe('Text sent unavailable for this decision.');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = JSON.parse(writeText.mock.calls[0][0]);
  expect(copied).not.toHaveProperty('cutoff');
  expect(copied).toMatchObject({
    textSent: textSent ?? null, scores: [{ label: 'birds', score: 0.5, cutoff: 0.290813258948728, strict: false, matched: true }],
  });
  expect(copied.scores[0].cutoff).toBe(0.290813258948728);
});

it.each([
  { textSent: '@alice these are words https://example.test', cutoff: 0.7, score: 0.69 },
  { textSent: 'these are four words', cutoff: 0.290813258948728, score: 0.2908 },
])('keeps the details and Copy details unmatched below $cutoff', async ({ textSent, cutoff, score }) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const details = createClassificationDetails({ textSent, scores: [{ label: 'birds', score }] }, null);
  document.body.append(details);
  expect(details.querySelector('li')?.textContent).toContain(`needs ${cutoff.toFixed(2)}`);
  expect(details.querySelector('li')?.textContent).toContain('Not matched');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
    textSent, scores: [{ label: 'birds', score, cutoff, strict: false, matched: false }],
  });
});

it('shows each current filter cutoff, Strict marker and short-post floor in details and Copy details', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const details = createClassificationDetails({
    textSent: 'three own words',
    scores: [{ label: 'birds', score: 0.71 }, { label: 'cats', score: 0.7 }],
  }, 'https://x.com/a/status/1', ['birds']);
  document.body.append(details);
  expect([...details.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    'birds · 0.71 · needs 0.72 · Strict · Not matched',
    'cats · 0.70 · needs 0.70 · short post · Matched',
  ]);
  expect(details.textContent).not.toContain('Matched when score');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = JSON.parse(writeText.mock.calls[0][0]);
  expect(copied).not.toHaveProperty('cutoff');
  expect(copied.scores).toEqual([
    { label: 'birds', score: 0.71, cutoff: 0.72, strict: true, matched: false },
    { label: 'cats', score: 0.7, cutoff: 0.7, strict: false, matched: true },
  ]);
});

it('rechecks current levels when reopening or copying an existing details node', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  let strict: string[] = [];
  const details = createClassificationDetails({ textSent: 'these are four words', scores: [{ label: 'birds', score: 0.5 }] }, null, () => strict);
  document.body.append(details);
  expect(details.querySelector('li')?.textContent).toContain('needs 0.29 · Matched');
  strict = ['birds'];
  details.dispatchEvent(new Event('toggle'));
  expect(details.querySelector('li')?.textContent).toContain('needs 0.72 · Strict · Not matched');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0][0]).scores).toEqual([{ label: 'birds', score: 0.5, cutoff: 0.72, strict: true, matched: false }]);
});

it('uses Strict for an old snapshot with no textSent while keeping the Standard general fallback', () => {
  const details = createClassificationDetails({ scores: [{ label: 'birds', score: 0.71 }, { label: 'cats', score: 0.5 }] }, null, ['birds']);
  expect([...details.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    'birds · 0.71 · needs 0.72 · Strict · Not matched',
    'cats · 0.50 · needs 0.29 · Matched',
  ]);
});

it('rounds only the displayed scores and cutoffs, preserving full precision in decisions and Copy details', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const scores = [
    { label: 'birds', score: 0.290813258948727 },
    { label: 'cats', score: 0.7199999999999999 },
  ];
  const details = createClassificationDetails({ textSent: 'these are four words', scores }, null, ['cats']);
  document.body.append(details);
  expect([...details.querySelectorAll('li')].map(item => item.textContent)).toEqual([
    'birds · 0.29 · needs 0.29 · Not matched',
    'cats · 0.72 · needs 0.72 · Strict · Not matched',
  ]);
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = JSON.parse(writeText.mock.calls[0][0]);
  expect(copied.scores).toEqual([
    { ...scores[0], cutoff: 0.290813258948728, strict: false, matched: false },
    { ...scores[1], cutoff: 0.72, strict: true, matched: false },
  ]);
  expect(copied.scores[0].score).toBe(0.290813258948727);
  expect(copied.scores[0].cutoff).toBe(0.290813258948728);
  expect(copied.scores[1].score).toBe(0.7199999999999999);
  expect(copied.scores[1].cutoff).toBe(0.72);
});
