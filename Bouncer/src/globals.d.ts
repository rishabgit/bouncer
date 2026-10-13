import type { PlatformAdapter } from './types';

declare global {
  var BouncerAdapter: new () => PlatformAdapter;
  var DOMPurify: {
    sanitize(dirty: string, config: { RETURN_DOM_FRAGMENT: true } & Record<string, unknown>): DocumentFragment;
    sanitize(dirty: string, config?: Record<string, unknown>): string;
  };

}

export {};
