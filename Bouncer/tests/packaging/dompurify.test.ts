/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { DOMPurify } from 'dompurify';
import { describe, expect, it } from 'vitest';

describe('packaged DOMPurify', () => {
  it('ships the exact installed minified distribution, including its license', () => {
    const shipped = readFileSync(new NodeURL('../../dompurify.js', import.meta.url));
    const installed = readFileSync(new NodeURL('../../node_modules/dompurify/dist/purify.min.js', import.meta.url));

    expect(shipped.equals(installed)).toBe(true);
  });

  it('returns a fragment without scripts, event handlers or JavaScript links', () => {
    const shippedSource = readFileSync(new NodeURL('../../dompurify.js', import.meta.url), 'utf8');
    // Execute the shipped UMD as a classic browser script, without CommonJS or AMD globals.
    new Function('module', 'exports', 'define', shippedSource).call(globalThis);
    const shippedDOMPurify = (globalThis as typeof globalThis & { DOMPurify: DOMPurify }).DOMPurify;
    const installedPackage = JSON.parse(readFileSync(new NodeURL('../../node_modules/dompurify/package.json', import.meta.url), 'utf8')) as { version: string };

    expect(shippedDOMPurify.isSupported).toBe(true);
    expect(shippedDOMPurify.version).toBe(installedPackage.version);
    const fragment = shippedDOMPurify.sanitize(
      '<p>Safe text</p><script>alert("script")</script>'
      + '<img src="https://example.com/picture.png" onerror="alert(\'event\')">'
      + '<a href="javascript:alert(\'url\')">Link text</a>',
      { RETURN_DOM_FRAGMENT: true },
    );

    expect(fragment).toBeInstanceOf(DocumentFragment);
    expect(fragment.querySelector('p')?.textContent).toBe('Safe text');
    expect(fragment.querySelector('script')).toBeNull();
    expect(fragment.querySelector('img')?.getAttribute('src')).toBe('https://example.com/picture.png');
    expect(fragment.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(fragment.querySelector('a')?.textContent).toBe('Link text');
    expect(fragment.querySelector('a')?.hasAttribute('href')).toBe(false);
  });
});
