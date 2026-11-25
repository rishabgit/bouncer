import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { publicValue } from './runtime.mjs';
import { WORDINGS } from './tone-templates.mjs';

const ROOT = new URL('../../', import.meta.url);
const DATE = '2026-11-25';
const SPLITS = ['discovery', 'holdout'];
export const CORPUS_FILES = Object.freeze(Object.fromEntries(SPLITS.map(split => [split,
  `scripts/decision-eval/corpora/tone-label-${split}-${DATE}.json`])));
export const AUDIT_FILE = 'decision-tone-label-audit.json';
const AUDIT_PATH = `docs/benchmarks/data/${AUDIT_FILE}`;
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const unique = values => new Set(values).size === values.length;
const sorted = values => [...values].sort();
const group = id => id === 'excessive-rudeness' ? id : id.startsWith('fresh-') ? 'fresh-*' : 'orig-*';

export function toneHash(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

function splitName(split) {
  insist(SPLITS.includes(split), 'Tone corpus split must be discovery or holdout');
  return split;
}
function publicOnly(value, description) {
  insist(same(value, publicValue(value)), `${description} requires redaction; use public text before building or binding a corpus`);
  return value;
}
function strings(values, description, allowed) {
  insist(Array.isArray(values) && values.every(nonempty) && unique(values)
    && (!allowed || values.every(value => allowed.includes(value))), `Invalid ${description}`);
}
function intentSet(intents) {
  insist(Array.isArray(intents) && intents.length === 18, 'Tone corpus requires 18 intents');
  const ids = intents.map(intent => intent?.id);
  insist(ids.every(nonempty) && unique(ids) && ids.includes('excessive-rudeness')
    && ids.filter(id => /^fresh-.+/.test(id)).length === 6 && ids.filter(id => /^orig-.+/.test(id)).length === 11,
  'Tone intents require excessive-rudeness, six fresh-* and eleven orig-* IDs');
  for (const intent of intents) {
    insist(record(intent) && nonempty(intent.source) && nonempty(intent.rubric), `Missing tone intent source or rubric: ${intent.id}`);
    if (intent.id === 'excessive-rudeness') insist(same(intent.labels, WORDINGS), 'Excessive-rudeness labels must equal the fixed W0–W12 wordings');
    else insist(nonempty(intent.label), `Missing tone intent label: ${intent.id}`);
  }
  return ids;
}
function normalizedIntents(rubrics) {
  const input = Array.isArray(rubrics) ? rubrics : rubrics?.intents;
  insist(Array.isArray(input), 'Rubrics must contain an intents array');
  const intents = input.map(intent => {
    insist(record(intent), 'Invalid tone intent');
    return { id: intent.id, source: intent.source, rubric: intent.rubric,
      ...(intent.id === 'excessive-rudeness' ? { labels: { ...WORDINGS } } : { label: intent.label }) };
  }).sort((a, b) => a.id === 'excessive-rudeness' ? -1 : b.id === 'excessive-rudeness' ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  intentSet(intents);
  return publicOnly(intents, 'Tone rubrics');
}
function authoredSplit(value, split, ids) {
  insist(record(value) && value.split === split && nonempty(value.author)
    && Array.isArray(value.posts) && value.posts.length > 0 && Array.isArray(value.twins), `Invalid authored ${split} corpus`);
  const posts = value.posts.map(post => {
    insist(record(post) && nonempty(post.id) && nonempty(post.part) && nonempty(post.text)
      && ids.includes(post.authoredFor) && nonempty(post.kind) && nonempty(post.subtype)
      && typeof post.ownIntentGold === 'boolean', `Invalid authored ${split} post: ${post?.id}`);
    return { id: post.id, part: post.part, text: post.text, authoredFor: post.authoredFor,
      kind: post.kind, subtype: post.subtype, ownIntentGold: post.ownIntentGold };
  });
  insist(unique(posts.map(post => post.id)), `Duplicate authored ${split} post ID`);
  const postIds = posts.map(post => post.id);
  const twins = value.twins.map(twin => {
    insist(record(twin) && nonempty(twin.id) && postIds.includes(twin.sourceId) && nonempty(twin.text), `Invalid diagnostic twin in ${split}`);
    return { id: twin.id, sourceId: twin.sourceId, text: twin.text };
  });
  insist(unique([...postIds, ...twins.map(twin => twin.id)]), `Duplicate or colliding diagnostic twin ID in ${split}`);
  return publicOnly({ split, author: value.author, posts, twins }, `Authored ${split} corpus`);
}
function labelerAnswers(value, postIds, ids) {
  insist(record(value) && nonempty(value.labeler) && Array.isArray(value.posts), 'Invalid blind labeler input');
  insist(value.posts.length === postIds.length && unique(value.posts.map(post => post?.id)), 'Each labeler must cover every post exactly once');
  const byId = new Map();
  for (const post of value.posts) {
    insist(record(post) && postIds.includes(post.id), `Unknown labeler post ID: ${post?.id}`);
    strings(post.yes, `yes answers for ${post.id}`, ids);
    strings(post.borderline, `borderline answers for ${post.id}`, ids);
    insist(!post.yes.some(id => post.borderline.includes(id)), `Yes and borderline answers intersect for ${post.id}`);
    byId.set(post.id, { id: post.id, yes: [...post.yes], borderline: [...post.borderline] });
  }
  insist(postIds.every(id => byId.has(id)), 'Each labeler must cover every post exactly once');
  return publicOnly({ labeler: value.labeler, posts: value.posts.map(post => byId.get(post.id)) }, 'Blind labeler answers');
}
const answer = (post, id) => post.borderline.includes(id) ? 'borderline' : post.yes.includes(id) ? 'yes' : 'no';
const agreesOwn = (response, gold) => response !== 'borderline' && (response === 'yes') === gold;
const tally = values => Object.fromEntries(sorted(new Set(values)).map(value => [value, values.filter(item => item === value).length]));

export function toneCounts(corpus) {
  const pairs = corpus.posts.length * corpus.intents.length;
  const ambiguousPairs = corpus.posts.reduce((total, post) => total + post.ambiguousFor.length, 0);
  const positivePairs = corpus.posts.reduce((total, post) => total + Object.values(post.gold).filter(Boolean).length, 0);
  return { posts: corpus.posts.length, intents: corpus.intents.length, pairs, twins: corpus.twins.length,
    ambiguousPairs, eligiblePairs: pairs - ambiguousPairs, positivePairs, negativePairs: pairs - positivePairs,
    byPart: tally(corpus.posts.map(post => post.part)), byKind: tally(corpus.posts.map(post => post.kind)),
    bySubtype: tally(corpus.posts.map(post => post.subtype)), byIntent: tally(corpus.posts.map(post => post.authoredFor)) };
}

/** Build both sealed splits without reading files, changing gold or contacting inference. */
export function buildToneCorpora(authoredD, authoredH, labeler1, labeler2, rubrics) {
  const intents = normalizedIntents(rubrics), ids = intents.map(intent => intent.id);
  const authored = [authoredSplit(authoredD, 'discovery', ids), authoredSplit(authoredH, 'holdout', ids)];
  const postIds = authored.flatMap(corpus => corpus.posts.map(post => post.id));
  const everyId = authored.flatMap(corpus => [...corpus.posts, ...corpus.twins].map(item => item.id));
  insist(unique(everyId), 'Post and twin IDs must be unique across discovery and holdout');
  const labelers = [labelerAnswers(labeler1, postIds, ids), labelerAnswers(labeler2, postIds, ids)];
  insist(labelers[0].labeler !== labelers[1].labeler, 'Two distinct blind labelers are required');
  const answers = labelers.map(labeler => new Map(labeler.posts.map(post => [post.id, post])));
  const ambiguous = [], ownIntentAgreement = [], allPairAgreement = [];
  const corpora = authored.map(source => {
    const posts = source.posts.map(post => {
      const gold = Object.fromEntries(ids.map(id => [id, id === post.authoredFor ? post.ownIntentGold : false]));
      const ambiguousFor = ids.filter(id => {
        const responses = answers.map(byId => answer(byId.get(post.id), id));
        const own = id === post.authoredFor;
        const uncertain = own ? !responses.every(response => agreesOwn(response, post.ownIntentGold)) : responses.some(response => response !== 'no');
        if (uncertain) ambiguous.push({ split: source.split, postId: post.id, intentId: id, ownIntent: own,
          gold: gold[id], answers: responses });
        return uncertain;
      });
      return { ...post, gold, ambiguousFor };
    });
    const corpus = { schemaVersion: 1, corpusId: `tone-label-${source.split}-${DATE}`, authoredDate: DATE,
      split: source.split, author: source.author,
      provenance: 'Synthetic authored posts with two independent rubric-based label sets. Own-intent gold is authored; other-intent gold is false. Ambiguous pairs are excluded from headline scores. Diagnostic twins are separate from scored posts.',
      intents: structuredClone(intents), posts, twins: source.twins };
    corpus.counts = toneCounts(corpus);
    validateToneCorpus(corpus, source.split);
    return corpus;
  });
  for (const [index, labeler] of labelers.entries()) {
    const splits = Object.fromEntries(authored.map(source => {
      const responses = source.posts.map(post => ({ response: answer(answers[index].get(post.id), post.authoredFor), gold: post.ownIntentGold }));
      const agreed = responses.filter(({ response, gold }) => agreesOwn(response, gold)).length;
      const borderline = responses.filter(({ response }) => response === 'borderline').length;
      return [source.split, { total: responses.length, agreed, disagreed: responses.length - agreed - borderline, borderline }];
    }));
    ownIntentAgreement.push({ labeler: labeler.labeler, ...sumCounts(Object.values(splits)), splits });
  }
  for (const source of authored) {
    const matrix = Object.fromEntries(['yes', 'no', 'borderline'].map(left => [left, Object.fromEntries(['yes', 'no', 'borderline'].map(right => [right, 0]))]));
    for (const post of source.posts) for (const id of ids) matrix[answer(answers[0].get(post.id), id)][answer(answers[1].get(post.id), id)]++;
    const total = source.posts.length * ids.length, agreed = Object.entries(matrix).reduce((sum, [response, counts]) => sum + counts[response], 0);
    allPairAgreement.push({ split: source.split, total, agreed, disagreed: total - agreed, matrix });
  }
  const counts = Object.fromEntries(corpora.map(corpus => [corpus.split, corpus.counts]));
  const audit = { schemaVersion: 1, studyId: `tone-label-${DATE}`, authors: Object.fromEntries(authored.map(source => [source.split, source.author])),
    counts, agreement: { ownIntent: ownIntentAgreement, allPairs: { ...sumCounts(allPairAgreement), splits: allPairAgreement } },
    ambiguous, labelers };
  return publicOnly({ discovery: corpora[0], holdout: corpora[1], audit }, 'Tone corpus build');
}
function sumCounts(items) {
  const keys = ['total', 'agreed', 'disagreed', 'borderline'].filter(key => items.some(item => key in item));
  return Object.fromEntries(keys.map(key => [key, items.reduce((sum, item) => sum + (item[key] ?? 0), 0)]));
}

/** Validate only the supplied split. Counts are derived, never production-size assumptions. */
export function validateToneCorpus(corpus, split) {
  splitName(split);
  insist(record(corpus) && corpus.schemaVersion === 1 && corpus.split === split
    && corpus.corpusId === `tone-label-${split}-${DATE}` && corpus.authoredDate === DATE
    && nonempty(corpus.author) && nonempty(corpus.provenance), `Invalid ${split} tone corpus identity`);
  const ids = intentSet(corpus.intents);
  const authored = authoredSplit(corpus, split, ids);
  for (const post of corpus.posts) {
    insist(record(post.gold) && same(sorted(Object.keys(post.gold)), sorted(ids)) && ids.every(id => typeof post.gold[id] === 'boolean'), `Invalid gold for ${post.id}`);
    insist(ids.every(id => post.gold[id] === (id === post.authoredFor ? post.ownIntentGold : false)), `Gold differs from authored own-intent policy for ${post.id}`);
    strings(post.ambiguousFor, `ambiguity flags for ${post.id}`, ids);
  }
  insist(same(corpus.counts, toneCounts(corpus)), `Derived ${split} tone corpus counts differ`);
  // authoredSplit checks twins and per-intent representation without requiring the other split.
  insist(authored.posts.length === corpus.posts.length, 'Tone post count differs');
  publicOnly(corpus, `${split} tone corpus`);
  return corpus;
}

export function toneRows(corpus) {
  validateToneCorpus(corpus, corpus?.split);
  return corpus.posts.flatMap(post => corpus.intents.map(intent => ({
    key: `tone-${corpus.split}:${post.id}:${intent.id}`, postId: post.id, text: post.text, intentId: intent.id,
    labelKey: intent.id, label: intent.id === 'excessive-rudeness' ? WORDINGS.W0 : intent.label,
    gold: post.gold[intent.id], ambiguous: post.ambiguousFor.includes(intent.id), authoredFor: post.authoredFor,
    kind: post.kind, part: post.part, subtype: post.subtype, corpus: `tone-${corpus.split}`, group: group(intent.id),
  })));
}
function rootURL(root) {
  if (root instanceof URL) return new URL(root.href.endsWith('/') ? root.href : `${root.href}/`);
  return pathToFileURL(`${resolve(root)}/`);
}
function inputURL(path, root) {
  return path instanceof URL ? path : new URL(pathToFileURL(resolve(fileURLToPath(root), path)).href);
}

/** Writes only the two new corpora and their audit, exclusively; an existing file is never replaced. */
export async function writeToneCorpora(inputPaths, { root = ROOT } = {}) {
  insist(record(inputPaths), 'Tone corpus input paths are required');
  const directory = rootURL(root), names = ['discovery', 'holdout', 'labeler1', 'labeler2', 'rubrics'];
  const inputs = await Promise.all(names.map(async name => {
    insist(typeof inputPaths[name] === 'string' || inputPaths[name] instanceof URL, `Missing tone corpus input path: ${name}`);
    return JSON.parse(await readFile(inputURL(inputPaths[name], directory), 'utf8'));
  }));
  const built = buildToneCorpora(...inputs);
  const paths = [CORPUS_FILES.discovery, CORPUS_FILES.holdout, AUDIT_PATH];
  // Apply publicValue to every JSON serialization. Building rejects any redaction that could change bindings.
  const serialize = value => JSON.stringify(publicValue(value), null, 2) + '\n';
  const bytes = [serialize(built.discovery), serialize(built.holdout)];
  const corpora = Object.fromEntries(SPLITS.map((split, index) => [split, { file: CORPUS_FILES[split], sha256: toneHash(bytes[index]) }]));
  built.audit.corpora = corpora;
  bytes.push(serialize(built.audit));
  const opened = [];
  try {
    for (const file of paths) {
      const target = new URL(file, directory);
      await mkdir(dirname(fileURLToPath(target)), { recursive: true });
      opened.push({ target, handle: await open(target, 'wx') });
    }
    for (const [index, { handle }] of opened.entries()) { await handle.writeFile(bytes[index]); await handle.sync(); }
  } catch (error) {
    await Promise.all(opened.map(async ({ handle, target }) => { await handle.close(); await unlink(target); }));
    throw error;
  }
  await Promise.all(opened.map(({ handle }) => handle.close()));
  return { corpora, counts: built.audit.counts };
}

/** Validate the split before I/O and read exactly its selected file, even when checking a hash. */
export async function loadToneCorpus(split, { root = ROOT, expectedHash, read = readFile } = {}) {
  splitName(split);
  insist(expectedHash === undefined || typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash), 'Invalid expected tone corpus SHA-256');
  const bytes = await read(new URL(CORPUS_FILES[split], rootURL(root)));
  if (expectedHash !== undefined) insist(toneHash(bytes) === expectedHash, `${split} tone corpus SHA-256 differs`);
  return validateToneCorpus(JSON.parse(bytes.toString()), split);
}
