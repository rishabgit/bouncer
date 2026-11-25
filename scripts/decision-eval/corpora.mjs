import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { templateHash as knownTemplateHash } from './templates.mjs';

export const CORPUS_HASHES = Object.freeze({
  'eval-corpus.ts': '4a2dacac7271704addb5c06d953021b8c8c7f20108cfa002ce11942a6e907214',
  'native-benchmark-corpus.ts': 'a5db3bf30aa3039a3e571020c111797e1cfdd675872514a40139e66db6038603',
  'native-isolation-holdout.json': '18841a6609d9e68493c629880bc03eeaa233eab890245e5cfd5c2eaa9e9d4159',
  'native-migration-validation.json': '354e80566fdf889e213aec9072387c42f8286a48347379b1142073cba3fa4e27',
});

// Exact category order used by the original native benchmark's categories(n).
// These latency presets retain its phrases rather than the broad corpus's
// expanded ones.
const LATENCY_FILTERS = Object.freeze([
  'crypto', 'politics', 'engagement bait', 'sports', 'ai hype',
  'celebrity gossip', 'self-promotion', 'food', 'fitness', 'drama',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameHashes(actual, expected) {
  return record(actual)
    && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([name, hash]) => actual[name] === hash);
}

const RUNTIME_FIELDS = Object.freeze([
  'runtime', 'version', 'build', 'effectiveContext', 'parallel', 'batch',
  'ubatch', 'projector', 'runner', 'quantization', 'aliasDefinition',
]);

function jsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Array.from(value).every(jsonValue);
  return record(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(jsonValue);
}

function runtimeSettings(value) {
  return record(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === RUNTIME_FIELDS.length
    && RUNTIME_FIELDS.every(field => Object.hasOwn(value, field))
    && ['llama', 'ollama'].includes(value.runtime)
    && typeof value.version === 'string' && value.version.trim()
    && typeof value.build === 'string' && value.build.trim()
    && jsonValue(value);
}

/** A v2 freeze receipt also binds the effective, observed serving settings. */
export function validateSelection(selection, variant, hashes, templateHash, currentRuntimeSettings) {
  if (!record(selection) || selection.frozen !== true) {
    throw new Error('Validation requires a frozen selection receipt');
  }
  if (selection.schemaVersion !== 2) throw new Error('Frozen selection schemaVersion must be 2');
  if (!record(variant) || typeof variant.id !== 'string' || !variant.id.trim()
      || typeof variant.templateId !== 'string' || !variant.templateId.trim()
      || selection.variantId !== variant.id || selection.templateId !== variant.templateId) {
    throw new Error('Frozen selection variant/template identity does not match');
  }
  if (!Number.isFinite(selection.cutoff) || selection.cutoff < 0 || selection.cutoff > 1) {
    throw new Error('Frozen selection cutoff must be finite and within [0,1]');
  }
  const expectedTemplateHash = knownTemplateHash(variant.templateId);
  if (templateHash !== expectedTemplateHash || selection.templateHash !== expectedTemplateHash) {
    throw new Error('Frozen selection template hash does not match');
  }
  if (!sameHashes(hashes, CORPUS_HASHES) || !sameHashes(selection.corpusHashes, hashes)) {
    throw new Error('Frozen selection corpus hashes do not match the pinned corpora');
  }
  if (!runtimeSettings(selection.runtimeSettings) || !runtimeSettings(currentRuntimeSettings)
      || !isDeepStrictEqual(selection.runtimeSettings, currentRuntimeSettings)) {
    throw new Error('Frozen selection runtime settings do not match current observed settings');
  }
  return selection;
}

async function verifiedFiles() {
  const manifest = JSON.parse(await readFile(new URL('./corpora/manifest.json', import.meta.url), 'utf8'));
  const manifestHashes = record(manifest.files)
    ? Object.fromEntries(Object.entries(manifest.files).map(([name, item]) => [name, item?.sha256])) : null;
  if (manifest.schemaVersion !== 1 || manifest.hashAlgorithm !== 'sha256'
      || !sameHashes(manifestHashes, CORPUS_HASHES)) {
    throw new Error('Corpus manifest does not match the pinned hashes');
  }
  const files = new Map();
  // Verify even sealed bytes without parsing their text or exposing their cases.
  for (const [name, pinned] of Object.entries(CORPUS_HASHES)) {
    const bytes = await readFile(new URL(`./corpora/${name}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== pinned) {
      throw new Error(`Corpus hash mismatch: ${name}`);
    }
    files.set(name, bytes);
  }
  return files;
}

function normalizeCase(item, corpus) {
  if (!record(item) || typeof item.id !== 'string' || !item.id.trim()
      || typeof item.text !== 'string' || !item.text.trim()
      || !Array.isArray(item.filters) || !item.filters.length
      || item.filters.some(filter => typeof filter !== 'string' || !filter.trim())
      || new Set(item.filters).size !== item.filters.length
      || !Array.isArray(item.expectedMatches)
      || item.expectedMatches.some(filter => !item.filters.includes(filter))
      || new Set(item.expectedMatches).size !== item.expectedMatches.length) {
    throw new Error(`Invalid ${corpus} corpus case`);
  }
  const expected = item.filters.map(filter => item.expectedMatches.includes(filter));
  if (item.expectedVerdicts !== undefined && (!Array.isArray(item.expectedVerdicts)
      || item.expectedVerdicts.length !== expected.length
      || item.expectedVerdicts.some((value, index) => value !== expected[index]))) {
    throw new Error(`Inconsistent ordered labels: ${item.id}`);
  }
  return { id: item.id, corpus, text: item.text, filters: [...item.filters], expected };
}

/**
 * Node 24 strips the self-contained discovery TypeScript directly; no transpiler or
 * generated JavaScript is needed. Validation text is returned only after its
 * frozen selection receipt has passed every binding check.
 */
export async function loadCorpora(splitOrOptions = 'discovery') {
  const options = typeof splitOrOptions === 'string' ? { split: splitOrOptions } : splitOrOptions;
  if (!record(options) || !['discovery', 'validation'].includes(options.split)) {
    throw new Error('Corpus split must be discovery or validation');
  }
  if (options.split === 'validation') {
    validateSelection(options.selection, options.variant, CORPUS_HASHES, options.templateHash, options.runtimeSettings);
  }
  const files = await verifiedFiles();
  const rageModule = await import('./corpora/eval-corpus.ts');
  const broadModule = await import('./corpora/native-benchmark-corpus.ts');
  let cases;
  if (options.split === 'discovery') {
    cases = [
      ...rageModule.EVAL_POSTS.map(post => normalizeCase({
        ...post, filters: ['rage bait'], expectedMatches: rageModule.expectsHide(post) ? ['rage bait'] : [],
      }, 'rage')),
      ...broadModule.MULTI_FILTER_CASES.map(post => normalizeCase(post, 'broad')),
    ];
  } else {
    cases = ['native-isolation-holdout.json', 'native-migration-validation.json'].flatMap(name => {
      const document = JSON.parse(files.get(name).toString('utf8'));
      if (document.schemaVersion !== 1 || !Array.isArray(document.cases)) {
        throw new Error(`Invalid validation document: ${name}`);
      }
      return document.cases.map(item => ({ ...normalizeCase(item,
        item.filters?.length === 1 && item.filters[0] === 'rage bait' ? 'rage' : 'broad'), sourceCorpus: name }));
    });
  }
  if (new Set(cases.map(item => `${item.corpus}:${item.id}`)).size !== cases.length) {
    throw new Error('Corpus case identities must be unique');
  }
  return {
    hashes: { ...CORPUS_HASHES },
    cases,
    latency: {
      posts: [...broadModule.NATIVE_LATENCY_POSTS.medium],
      filters3: LATENCY_FILTERS.slice(0, 3),
      filters10: [...LATENCY_FILTERS],
    },
  };
}
