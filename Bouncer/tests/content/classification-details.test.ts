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
  expect(details.textContent).toContain('Matched when score ≥ 0.290813258948728');
  expect(details.querySelector('li')?.textContent).toBe('birds · 0.50 · Matched');
  if (textSent == null) expect(details.querySelector('pre')?.textContent).toBe('Text sent unavailable for this decision.');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
    cutoff: 0.290813258948728, textSent: textSent ?? null, scores: [{ label: 'birds', score: 0.5, matched: true }],
  });
});

it.each([
  { textSent: '@alice these are words https://example.test', cutoff: 0.7, score: 0.69 },
  { textSent: 'these are four words', cutoff: 0.290813258948728, score: 0.2908 },
])('keeps the details and Copy details unmatched below $cutoff', async ({ textSent, cutoff, score }) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const details = createClassificationDetails({ textSent, scores: [{ label: 'birds', score }] }, null);
  document.body.append(details);
  expect(details.textContent).toContain(`Matched when score ≥ ${cutoff}`);
  expect(details.querySelector('li')?.textContent).toContain('Not matched');
  details.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
    cutoff, textSent, scores: [{ label: 'birds', score, matched: false }],
  });
});
