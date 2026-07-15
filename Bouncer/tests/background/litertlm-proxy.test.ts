import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forceCloseLitertlmOffscreen,
  LitertlmProxy,
} from '../../src/background/backends/litertlm-proxy.js';

describe('LitertlmProxy offscreen lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shares the first offscreen creation across concurrent sends', async () => {
    let finishCreation!: () => void;
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn(() => new Promise<void>(resolve => {
      finishCreation = resolve;
    }));
    const sendMessage = vi.fn(async (request: { method?: string }) => ({
      ok: true,
      value: request.method === 'countTokens' ? 7 : 'truncated',
    }));

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
      offscreen: {
        hasDocument,
        createDocument,
        closeDocument: vi.fn(),
      },
    } as unknown as typeof chrome;

    const proxy = new LitertlmProxy();
    const count = proxy.countTokens('some text');
    const truncate = proxy.truncateText('some text', 3);

    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
    expect(hasDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    finishCreation();

    await expect(Promise.all([count, truncate])).resolves.toEqual([7, 'truncated']);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('re-checks and retries after offscreen creation fails', async () => {
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn()
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, value: 7 });

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
      offscreen: {
        hasDocument,
        createDocument,
        closeDocument: vi.fn(),
      },
    } as unknown as typeof chrome;

    const proxy = new LitertlmProxy();
    await expect(proxy.countTokens('some text')).rejects.toThrow('creation failed');
    await expect(proxy.countTokens('some text')).resolves.toBe(7);

    expect(hasDocument).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('waits for a coalesced close before concurrent sends create a new document', async () => {
    let finishClose!: () => void;
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn().mockResolvedValue(undefined);
    const closeDocument = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        finishClose = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    const sendMessage = vi.fn(async (request: { method?: string }) => ({
      ok: true,
      value: request.method === 'countTokens' ? 7 : 'truncated',
    }));

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
      offscreen: {
        hasDocument,
        createDocument,
        closeDocument,
      },
    } as unknown as typeof chrome;

    const firstClose = forceCloseLitertlmOffscreen();
    const secondClose = forceCloseLitertlmOffscreen();
    const proxy = new LitertlmProxy();
    const count = proxy.countTokens('some text');
    const truncate = proxy.truncateText('some text', 3);

    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledTimes(1));
    expect(hasDocument).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    finishClose();

    await expect(Promise.all([firstClose, secondClose, count, truncate]))
      .resolves.toEqual([true, true, 7, 'truncated']);
    expect(hasDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    await expect(forceCloseLitertlmOffscreen()).resolves.toBe(true);
    expect(closeDocument).toHaveBeenCalledTimes(2);
  });

  it('clears a failed coalesced close so the next close can retry', async () => {
    const closeDocument = vi.fn()
      .mockRejectedValueOnce(new Error('no document'))
      .mockResolvedValueOnce(undefined);
    globalThis.chrome = {
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
      },
      offscreen: {
        hasDocument: vi.fn(),
        createDocument: vi.fn(),
        closeDocument,
      },
    } as unknown as typeof chrome;

    const firstClose = forceCloseLitertlmOffscreen();
    const secondClose = forceCloseLitertlmOffscreen();
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([false, false]);
    expect(closeDocument).toHaveBeenCalledTimes(1);

    await expect(forceCloseLitertlmOffscreen()).resolves.toBe(true);
    expect(closeDocument).toHaveBeenCalledTimes(2);
  });

  it('orders a close requested during creation after that creation', async () => {
    let finishCreation!: () => void;
    const order: string[] = [];
    const hasDocument = vi.fn().mockResolvedValue(false);
    const createDocument = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('create-start');
        await new Promise<void>(resolve => {
          finishCreation = resolve;
        });
        order.push('create-finish');
      })
      .mockImplementationOnce(async () => {
        order.push('replacement-create');
      });
    const closeDocument = vi.fn().mockImplementation(async () => {
      order.push('close');
    });
    const sendMessage = vi.fn().mockImplementation(async () => {
      order.push('send');
      return { ok: true, value: 7 };
    });

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
      offscreen: {
        hasDocument,
        createDocument,
        closeDocument,
      },
    } as unknown as typeof chrome;

    const proxy = new LitertlmProxy();
    const firstSend = proxy.countTokens('some text');
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));

    const close = forceCloseLitertlmOffscreen();
    expect(closeDocument).not.toHaveBeenCalled();
    finishCreation();

    await expect(Promise.all([firstSend, close])).resolves.toEqual([7, true]);
    expect(order.indexOf('close')).toBeGreaterThan(order.indexOf('create-finish'));
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('close'));

    await expect(proxy.countTokens('some text')).resolves.toBe(7);
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(order.indexOf('replacement-create')).toBeGreaterThan(order.indexOf('close'));
  });
});
