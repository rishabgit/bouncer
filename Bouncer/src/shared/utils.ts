// Shared pure utility functions used by background, content, and popup scripts

import type { PostContent } from '../types';

/** ASCII code units cost one; every other UTF-16 code unit costs two. */
export function weightedTextLength(text: string): number {
  let weight = 0;
  for (let index = 0; index < text.length; index++) {
    weight += text.charCodeAt(index) <= 0x7f ? 1 : 2;
  }
  return weight;
}

/** Bound weighted text without splitting a UTF-16 surrogate pair. */
export function truncateText(text: string, maxWeight: number): string {
  let weight = 0;
  let end = 0;
  for (const character of text) {
    const characterWeight = character.length === 2 ? 4 : character.charCodeAt(0) <= 0x7f ? 1 : 2;
    if (weight + characterWeight > maxWeight) break;
    weight += characterWeight;
    end += character.length;
  }
  return text.slice(0, end);
}

// Adapters keep only the post's own words in text; quotes remain display data.
// Format that text into the string sent to the AI for evaluation.
// This is also the basis for cache keys and feedback payloads.
export function formatPostForEvaluation(post: PostContent): string {
  return post.text;
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
