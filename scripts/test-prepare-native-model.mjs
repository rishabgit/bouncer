import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { HELP_TEXT, importLocalModel, main, parseArguments } from './prepare-native-model.mjs';

test('help returns operator instructions without running any model preparation', async () => {
  let prepared = 0;
  const forbiddenPreparation = () => { prepared++; throw new Error('native preparation was invoked'); };
  for (const argument of ['--help', '-h']) {
    assert.equal(await main([argument], forbiddenPreparation), HELP_TEXT);
    assert.equal(await main([argument]), HELP_TEXT);
  }
  assert.equal(prepared, 0);
  assert.match(HELP_TEXT, /Ollama 0\.40\.3/);
  assert.match(HELP_TEXT, /no resident/);
  assert.match(HELP_TEXT, /without inference/);
  assert.match(HELP_TEXT, /Nothing is downloaded/);
  assert.match(HELP_TEXT, /\.native-preparation/);
});

test('unsupported arguments fail before preparation and never print supplied values', async () => {
  let prepared = 0;
  const forbiddenPreparation = () => { prepared++; throw new Error('native preparation was invoked'); };
  for (const args of [['--synthetic-secret'], ['--help', '--synthetic-secret'], ['synthetic-secret'], ['--prepare'], ['--help', '--help']]) {
    await assert.rejects(main(args, forbiddenPreparation), error => /Unsupported model preparation option/.test(error.message) && !error.message.includes('synthetic-secret'));
  }
  assert.equal(prepared, 0);
});

test('no-argument dispatch runs the injected preparation exactly once and preserves failure', async () => {
  let prepared = 0;
  const result = { prepared: true };
  assert.equal(parseArguments([]), 'prepare');
  assert.equal(await main([], () => { prepared++; return result; }), result);
  assert.equal(prepared, 1);
  await assert.rejects(main([], () => { throw new Error('synthetic preparation failure'); }), /synthetic preparation failure/);
});

test('import pins the mutating child to loopback despite an inherited remote host', async () => {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'https://example.invalid:9443';
  let observed;
  try {
    await importLocalModel('/synthetic/Modelfile', (command, args, options) => {
      observed = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    assert.equal(observed.command, 'ollama');
    assert.deepEqual(observed.args, ['create', 'bouncer-gemma4-e2b-qat-text:v1', '-f', '/synthetic/Modelfile']);
    assert.equal(observed.options.env.OLLAMA_HOST, 'http://127.0.0.1:11434');
    assert.equal(observed.options.env.PATH, process.env.PATH);
    assert.equal(process.env.OLLAMA_HOST, 'https://example.invalid:9443');
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
});

test('a failed import never reports success', async () => {
  await assert.rejects(importLocalModel('/synthetic/Modelfile', () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  }), /exited 1/);
});
