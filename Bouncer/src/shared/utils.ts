// Shared pure utility functions used by background, content, and popup scripts

import type { PostContent } from '../types';

// Format a post's content into the string sent to the AI for evaluation.
// This is also the basis for cache keys and feedback payloads.
export function formatPostForEvaluation(post: PostContent): string {
  return `${post.author}: ${post.text}`;
}

// Generate a compact cache key from the complete text-only model input.
// The readable prefix helps diagnostics; a 64-bit-style dual hash plus length
// keeps distinct long posts from aliasing when their first characters match.
export function generateCacheKey(post: string): string {
  const normalizedPost = post.replace(/\s+/g, ' ').trim();
  let h1 = 0xdeadbeef ^ normalizedPost.length;
  let h2 = 0x41c6ce57 ^ normalizedPost.length;
  for (let index = 0; index < normalizedPost.length; index++) {
    const code = normalizedPost.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const fingerprint = `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
  return `${normalizedPost.length}:${fingerprint}:${normalizedPost.slice(0, 120)}`;
}

// Helper to detect GPU device lost or OOM errors
export function isGPUDeviceLostError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const lowerError = errorMessage.toLowerCase();
  return (lowerError.includes('device') && (lowerError.includes('lost') || lowerError.includes('destroyed'))) ||
         (lowerError.includes('out of memory') || lowerError.includes('oom')) ||
         lowerError.includes('resource_exhausted') ||
         lowerError.includes('gpu') && lowerError.includes('memory');
}

// Helper to detect network/download errors that are retryable
export function isNetworkError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const lowerError = errorMessage.toLowerCase();
  return lowerError.includes('fetch') ||
         lowerError.includes('network') ||
         lowerError.includes('failed to load') ||
         lowerError.includes('connection') ||
         lowerError.includes('timeout') && !lowerError.includes('inference');
}

// Format a parsed local-inference result for the evaluation pipeline.
export function formatLocalInferenceResult(reasoning: string, shouldHide: boolean): { shouldHide: boolean; reasoning: string } {
  return {
    shouldHide: shouldHide,
    reasoning: reasoning || 'No reasoning provided'
  };
}

// Clean reasoning string by removing "category n: " prefixes and "|" separators
export function cleanReasoning(reasoning: string | null | undefined): string | null | undefined {
  if (!reasoning) return reasoning;
  try {
    const cleaned = reasoning
      .replace(/category\s*\d+\s*:\s*/gi, '')  // Remove "category n: " prefixes
      .split('|')                               // Split by "|"
      .map(s => s.trim())                       // Trim each part
      .filter(s => s.length > 0)                // Remove empty parts
      .join(' ');
    return cleaned || reasoning;  // Fall back to original if result is empty
  } catch {
    return reasoning;  // Fall back to original on any error
  }
}

// HTML escape for safe DOM insertion
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Parse an HTML string into a DocumentFragment, sanitized via DOMPurify so
// any accidentally-interpolated hostile markup is stripped before it ever
// touches the live DOM. All call sites pass this through `replaceChildren`.
export function parseHTML(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
}
