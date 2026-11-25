import type { ClassificationDetails } from '../types';
import { DECISION_MODEL, decideMatches } from '../shared/decision-model';
import { asyncHandler } from '../shared/async';

/** Only request/decision data belongs in the export, never display metadata. */
export function createClassificationDetails(
  classification: ClassificationDetails | undefined,
  postUrl: string | null,
  strictPhrases: readonly string[] | (() => readonly string[]) = [],
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'classification-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  details.appendChild(summary);

  const currentScores = () => decideMatches(
    classification?.scores ?? [], classification?.textSent,
    typeof strictPhrases === 'function' ? strictPhrases() : strictPhrases,
  ).scores;
  const list = classification?.scores?.length ? document.createElement('ul') : undefined;
  if (list) list.className = 'classification-scores';
  const renderScores = () => {
    if (!list) return;
    list.replaceChildren();
    for (const { label, score, cutoff, strict, shortPost, matched } of currentScores()) {
      const item = document.createElement('li');
      const level = strict ? ' · Strict' : shortPost ? ' · short post' : '';
      item.textContent = `${label} · ${score.toFixed(2)} · needs ${cutoff.toFixed(2)}${level} · ${matched ? 'Matched' : 'Not matched'}`;
      list.appendChild(item);
    }
    list.hidden = !list.childElementCount;
  };
  if (list) {
    renderScores();
    details.appendChild(list);
    details.addEventListener('toggle', renderScores);
  }

  const textLabel = document.createElement('p');
  textLabel.textContent = 'Exact text sent to the model';
  details.appendChild(textLabel);
  const text = document.createElement('pre');
  text.className = 'classification-text';
  text.setAttribute('aria-label', 'Exact text sent to the model');
  text.textContent = classification?.textSent ?? 'Text sent unavailable for this decision.';
  details.appendChild(text);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'classification-copy';
  copy.textContent = 'Copy details';
  const status = document.createElement('span');
  status.className = 'classification-copy-status';
  status.setAttribute('role', 'status');
  let fallback: HTMLTextAreaElement | undefined;
  copy.addEventListener('click', asyncHandler(async () => {
    renderScores();
    const scores = currentScores().map(({ label, score, cutoff, strict, matched }) => ({ label, score, cutoff, strict, matched }));
    const json = JSON.stringify({
      bouncerVersion: chrome.runtime.getManifest().version,
      model: classification?.model ?? DECISION_MODEL.id,
      templateId: DECISION_MODEL.templateId,
      postUrl,
      textSent: classification?.textSent ?? null,
      scores,
      classifiedAt: classification?.timestamp ?? null,
    }, null, 2);
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(json);
      status.textContent = 'Copied';
      if (fallback) fallback.hidden = true;
      setTimeout(() => { status.textContent = ''; }, 1500);
    } catch {
      if (!fallback) {
        fallback = document.createElement('textarea');
        fallback.className = 'classification-copy-fallback';
        fallback.readOnly = true;
        fallback.setAttribute('aria-label', 'Details JSON — copy the selected text');
        details.appendChild(fallback);
      }
      fallback.hidden = false;
      fallback.value = json;
      fallback.focus();
      fallback.select();
      status.textContent = 'Copy the selected JSON.';
    } finally {
      copy.disabled = false;
    }
  }));
  details.append(copy, status);
  return details;
}
