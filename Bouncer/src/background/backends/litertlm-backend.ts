import type { BrowserBackend, BrowserProgress, BrowserState } from './types';
import type { ChatMessage } from '../../types';
import { LitertlmProxy } from './litertlm-proxy';

/** Chrome service worker façade. The SDK is imported only by offscreen.js. */
export class LitertlmBackend implements BrowserBackend {
  private readonly proxy = new LitertlmProxy();
  getState(): Promise<BrowserState> { return this.proxy.getState(); }
  download(progress: (value: BrowserProgress) => void, signal: AbortSignal): Promise<void> { return this.proxy.download(progress, signal); }
  initialize(progress: (value: BrowserProgress) => void, signal: AbortSignal): Promise<void> { return this.proxy.initialize(progress, signal); }
  generate(messages: ChatMessage[], maxTokens: number): Promise<string> { return this.proxy.generate(messages, maxTokens); }
  countTokens(text: string): Promise<number> { return Promise.resolve(Math.ceil(text.length / 3)); }
  truncateText(text: string, maxTokens: number): Promise<string> {
    let bounded = text.slice(0, Math.max(0, maxTokens) * 3);
    if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
    return Promise.resolve(bounded);
  }
  interrupt(): Promise<void> { return this.proxy.interrupt(); }
  unload(): Promise<void> { return this.proxy.unload(); }
  forceClose(): Promise<void> { return this.proxy.forceClose(); }
  deleteCache(): Promise<void> { return this.proxy.deleteCache(); }
}
export { LitertlmBackend as LiteRTLMBackend };
