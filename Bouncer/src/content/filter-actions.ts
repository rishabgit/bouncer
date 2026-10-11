import type { PlatformAdapter } from '../types';
import { formatPostForEvaluation } from '../shared/utils';

export interface LivePostDecision {
  identity: string;
  shouldHide: boolean;
  matches?: string[];
  userOverride?: boolean;
}

// This state deliberately does not depend on panel retention and does not keep
// detached X articles alive. Collateral thread cells without a decision are
// restored and evaluated when rules change.
const livePostDecisions = new WeakMap<HTMLElement, LivePostDecision>();

export function postIdentity(adapter: PlatformAdapter, article: HTMLElement): string {
  return `${adapter.getPostContentKey(article)}\n${formatPostForEvaluation(adapter.extractPostContent(article))}`;
}

export function rememberPostDecision(article: HTMLElement, decision: LivePostDecision): void {
  livePostDecisions.set(article, {
    ...decision,
    matches: decision.matches ? [...decision.matches] : undefined,
  });
}

export function getPostDecision(article: HTMLElement): LivePostDecision | undefined {
  return livePostDecisions.get(article);
}

export function forgetPostDecision(article: HTMLElement): void {
  livePostDecisions.delete(article);
}

export function currentPostDecision(adapter: PlatformAdapter, article: HTMLElement): LivePostDecision | undefined {
  const decision = getPostDecision(article);
  return decision?.identity === postIdentity(adapter, article) ? decision : undefined;
}

export function isPostIdentityCurrent(adapter: PlatformAdapter, article: HTMLElement, identity: string): boolean {
  return article.isConnected && postIdentity(adapter, article) === identity;
}

/** Only exact, complete matches can prove that an automatic hide survives. */
export function survivingMatches(matches: string[] | undefined, phrases: string[]): string[] | null {
  if (!matches?.length || matches.some(match => typeof match !== 'string' || !match)) return null;
  const active = new Set(phrases);
  return matches.filter(match => active.has(match));
}

/** Legacy labels are a display fallback, never evidence for a hide decision. */
export function displayedMatches(value: { matches?: string[]; category?: string | null }): string[] {
  return value.matches !== undefined
    ? value.matches
    : (value.category || '').split(',').map(match => match.trim()).filter(Boolean);
}
