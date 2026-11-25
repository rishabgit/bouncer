import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDescriptions, setDescriptions } from '../../src/shared/storage.js';

function mockStorage(value: unknown) {
  const get = vi.fn(async () => ({ descriptions_twitter: value }));
  const set = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { storage: { local: { get, set, remove } } });
  return { get, set, remove };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('canonical filter storage', () => {
  it('reads only the canonical list without mutation and preserves exact phrase order', async () => {
    const storage = mockStorage(['  exact  ', 'duplicate', 'duplicate', '', '   ', '\n\t', 1, null]);
    expect(await getDescriptions('descriptions_twitter')).toEqual(['  exact  ', 'duplicate', 'duplicate']);
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(['descriptions_twitter']);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each([{ value: [] }, { value: undefined }, { value: 'invalid' }])('returns an empty list for $value without storage writes', async ({ value }) => {
    const storage = mockStorage(value);
    expect(await getDescriptions('descriptions_twitter')).toEqual([]);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('persists only the supplied canonical array', async () => {
    const storage = mockStorage([]);
    await setDescriptions('descriptions_twitter', ['one', '  two  ']);
    expect(storage.set).toHaveBeenCalledExactlyOnceWith({ descriptions_twitter: ['one', '  two  '] });
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
