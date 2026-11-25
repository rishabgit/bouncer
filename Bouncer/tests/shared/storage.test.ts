import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDescriptions, setDescriptions, getFilterSettings, setFilterStrictness } from '../../src/shared/storage.js';

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

  it('persists the supplied canonical array with a same-write empty Strict list', async () => {
    const storage = mockStorage([]);
    await setDescriptions('descriptions_twitter', ['one', '  two  ']);
    expect(storage.set).toHaveBeenCalledExactlyOnceWith({ descriptions_twitter: ['one', '  two  '], strictFilters_twitter: [] });
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(['descriptions_twitter', 'strictFilters_twitter']);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('exact per-filter Strict storage', () => {
  function storageWith(values: Record<string, unknown>) {
    const storage = mockStorage(undefined);
    storage.get.mockImplementation(async () => structuredClone(values) as { descriptions_twitter: unknown });
    storage.set.mockImplementation(async items => { Object.assign(values, structuredClone(items)); });
    return storage;
  }

  it('reads a missing Strict key as Standard without creating storage', async () => {
    const storage = storageWith({ descriptions_twitter: ['one'] });
    expect(await getFilterSettings('descriptions_twitter')).toEqual({ descriptions: ['one'], strictFilters: [] });
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('reads exact active phrases and their Strict intersection in one storage snapshot', async () => {
    const storage = storageWith({
      descriptions_twitter: ['  exact  ', 'duplicate', 'duplicate', '', '   ', 1, null],
      strictFilters_twitter: ['exact', '  exact  ', 'removed', 'duplicate', '', 2, null],
    });
    expect(await getFilterSettings('descriptions_twitter')).toEqual({
      descriptions: ['  exact  ', 'duplicate', 'duplicate'],
      strictFilters: ['  exact  ', 'duplicate'],
    });
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(['descriptions_twitter', 'strictFilters_twitter']);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('keeps exact existing phrases Strict across additions and duplicate phrase saves', async () => {
    const storage = storageWith({ descriptions_twitter: ['one', '  exact  '], strictFilters_twitter: ['  exact  '] });
    await setDescriptions('descriptions_twitter', ['one', '  exact  ', 'new', '  exact  ']);
    expect(storage.set).toHaveBeenCalledExactlyOnceWith({
      descriptions_twitter: ['one', '  exact  ', 'new', '  exact  '], strictFilters_twitter: ['  exact  '],
    });
    expect(await getFilterSettings('descriptions_twitter')).toEqual({ descriptions: ['one', '  exact  ', 'new', '  exact  '], strictFilters: ['  exact  '] });
  });

  it('drops a removed phrase from Strict in the same write, and re-added phrases start Standard', async () => {
    const values = { descriptions_twitter: ['one', 'two'], strictFilters_twitter: ['one', 'two'] };
    const storage = storageWith(values);
    await setDescriptions('descriptions_twitter', ['two']);
    expect(storage.set).toHaveBeenLastCalledWith({ descriptions_twitter: ['two'], strictFilters_twitter: ['two'] });
    await setDescriptions('descriptions_twitter', ['two', 'one']);
    expect(storage.set).toHaveBeenLastCalledWith({ descriptions_twitter: ['two', 'one'], strictFilters_twitter: ['two'] });
    expect(values.strictFilters_twitter).toEqual(['two']);
  });

  it('toggles exact phrases while retaining other Strict entries and treating repeated actions as no-ops', async () => {
    const storage = storageWith({ descriptions_twitter: ['one', '  two  '], strictFilters_twitter: ['one'] });
    await setFilterStrictness('descriptions_twitter', '  two  ', true);
    expect(await getFilterSettings('descriptions_twitter')).toEqual({ descriptions: ['one', '  two  '], strictFilters: ['one', '  two  '] });
    await setFilterStrictness('descriptions_twitter', 'one', true);
    expect(storage.set).toHaveBeenCalledTimes(1);
    await setFilterStrictness('descriptions_twitter', 'one', false);
    expect(await getFilterSettings('descriptions_twitter')).toEqual({ descriptions: ['one', '  two  '], strictFilters: ['  two  '] });
    await expect(setFilterStrictness('descriptions_twitter', 'two', true)).rejects.toThrow('no longer saved');
  });
});
