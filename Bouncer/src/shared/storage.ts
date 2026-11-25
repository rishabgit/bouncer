import type {
  DescriptionKey,
  StorageSchema,
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

export async function setDescriptions(descriptionsKey: DescriptionKey, descriptions: string[]): Promise<void> {
  await chrome.storage.local.set({ [descriptionsKey]: descriptions });
}
