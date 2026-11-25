import type {
  DescriptionKey,
  StorageSchema,
  StrictFiltersKey,
} from '../types';

/** Typed wrapper around chrome.storage.local.get(). Values may be undefined if not yet set. */
export async function getStorage<K extends keyof StorageSchema>(
  keys: K[]
): Promise<Partial<Pick<StorageSchema, K>>> {
  return chrome.storage.local.get(keys);
}

/** Typed wrapper around chrome.storage.local.set(). */
export async function setStorage(
  items: Partial<StorageSchema>
): Promise<void> {
  await chrome.storage.local.set(items);
}

/** Typed wrapper around chrome.storage.local.remove(). */
export async function removeStorage<K extends keyof StorageSchema>(
  keys: K | K[]
): Promise<void> {
  await chrome.storage.local.remove(keys);
}

export async function getDescriptions(descriptionsKey: DescriptionKey): Promise<string[]> {
  const data = await getStorage([descriptionsKey]);
  const descriptions = data[descriptionsKey];
  return Array.isArray(descriptions)
    ? descriptions.filter((phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0)
    : [];
}

/** Worker-only: serialize this read/write with every phrase and Strict action. */
export async function setDescriptions(descriptionsKey: DescriptionKey, descriptions: string[]): Promise<void> {
  const strictKey = strictFiltersKey(descriptionsKey);
  const data = await getStorage([descriptionsKey, strictKey]);
  // Newly added phrases always start at Standard. Retained exact phrases keep
  // their level, and removal prunes their Strict entry in the same write.
  const previous = phrases(data[descriptionsKey]);
  const strict = phrases(data[strictKey]).filter(phrase => previous.includes(phrase) && descriptions.includes(phrase));
  await setStorage({ [descriptionsKey]: descriptions, [strictKey]: strict });
}

function strictFiltersKey(descriptionsKey: DescriptionKey): StrictFiltersKey {
  return `strictFilters_${descriptionsKey.slice('descriptions_'.length)}` as StrictFiltersKey;
}

function phrases(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0)
    : [];
}

/** Read phrases and their saved levels from one snapshot. Missing Strict means Standard. */
export async function getFilterSettings(descriptionsKey: DescriptionKey): Promise<{
  descriptions: string[];
  strictFilters: string[];
}> {
  const strictKey = strictFiltersKey(descriptionsKey);
  const data = await getStorage([descriptionsKey, strictKey]);
  const descriptions = phrases(data[descriptionsKey]);
  const strictFilters = phrases(data[strictKey]).filter(phrase => descriptions.includes(phrase));
  return { descriptions, strictFilters };
}

/** Callers serialize this read/write with other phrase actions. */
export async function setFilterStrictness(descriptionsKey: DescriptionKey, phrase: string, strict: boolean): Promise<void> {
  const strictKey = strictFiltersKey(descriptionsKey);
  const data = await getStorage([descriptionsKey, strictKey]);
  const descriptions = phrases(data[descriptionsKey]);
  if (!descriptions.includes(phrase)) throw new Error('Filter phrase is no longer saved.');
  const current = phrases(data[strictKey]).filter(value => descriptions.includes(value));
  const updated = strict
    ? current.includes(phrase) ? current : [...current, phrase]
    : current.filter(value => value !== phrase);
  if (current.length === updated.length && current.every((value, index) => value === updated[index])) return;
  await setStorage({ [strictKey]: updated });
}
