/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { createModelLoadingCoordinator, modelStatusView } from '../../src/content/ui.js';
import type { LocalModelStatus } from '../../src/types.js';

const status = (state: LocalModelStatus['state'], revision: number): LocalModelStatus => ({ state, revision, message: '' });
const change = (oldValue: LocalModelStatus, newValue: LocalModelStatus) => ({ nativeModelStatus: { oldValue, newValue } });

describe('model status initialization', () => {
  it('replays readiness received before a stale initial read and processes posts once', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.handleChanges(change(status('unavailable', 1), status('ready', 2)));
    expect(render).not.toHaveBeenCalled();
    coordinator.finishInitialLoad({ nativeModelStatus: status('unavailable', 1) });
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(status('ready', 2));
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('uses event oldValue when the snapshot already contains the readiness event', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.handleChanges(change(status('unavailable', 1), status('ready', 2)));
    coordinator.finishInitialLoad({ nativeModelStatus: status('ready', 2) });
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('rejects an older queued event when the snapshot has a newer revision', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.handleChanges(change(status('unavailable', 1), status('ready', 2)));
    coordinator.finishInitialLoad({ nativeModelStatus: status('settings_required', 3) });
    expect(render).toHaveBeenLastCalledWith(status('settings_required', 3));
    expect(processPosts).not.toHaveBeenCalled();
    coordinator.handleChanges(change(status('ready', 2), status('checking', 2)));
    expect(render).toHaveBeenCalledOnce();
  });

  it('does not reprocess posts after an ordinary status check or unrelated events', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status('checking', 1) });
    coordinator.handleChanges(change(status('checking', 1), status('ready', 2)));
    coordinator.handleChanges({ filterReplies: { oldValue: true, newValue: false } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(processPosts).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'missing_model', 'settings_required'] as const)('reprocesses eligible posts when %s becomes ready', state => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status(state, 1) });
    coordinator.handleChanges(change(status(state, 1), status('ready', 2)));
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('does not retry a failed post when later filtering becomes ready', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status('error', 1) });
    coordinator.handleChanges(change(status('error', 1), status('ready', 2)));
    expect(processPosts).not.toHaveBeenCalled();
  });

  it('retains unavailable work through a transient status check', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status('unavailable', 1) });
    coordinator.handleChanges(change(status('unavailable', 1), status('checking', 2)));
    coordinator.handleChanges(change(status('checking', 2), status('ready', 3)));
    coordinator.handleChanges(change(status('ready', 3), status('checking', 4)));
    coordinator.handleChanges(change(status('checking', 4), status('ready', 5)));
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('retains queued unavailable work when the initial snapshot already contains the final check', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.handleChanges(change(status('unavailable', 1), status('checking', 2)));
    coordinator.handleChanges(change(status('checking', 2), status('ready', 3)));
    coordinator.finishInitialLoad({ nativeModelStatus: status('ready', 3) });
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('normalizes an unknown stored state before rendering and accepts a newer readiness event', () => {
    const render = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, vi.fn());
    coordinator.finishInitialLoad({ nativeModelStatus: { state: 'retired-state', message: 'Stale', revision: 7 } });
    expect(render).toHaveBeenLastCalledWith({ state: 'checking', message: 'Checking Llama.app…', revision: 7 });
    coordinator.handleChanges({ nativeModelStatus: { newValue: status('ready', 8) } });
    expect(render).toHaveBeenLastCalledWith(status('ready', 8));
  });
});

describe('feed model status', () => {
  it('keeps healthy readiness quiet', () => {
    expect(modelStatusView(status('ready', 1))).toBeNull();
  });

  it('shows checking without a made-up percentage or duration', () => {
    expect(modelStatusView(status('checking', 1))).toEqual({
      body: 'Checking Llama.app…', variant: 'progress', dismissible: false,
    });
  });

  it.each(['unavailable', 'missing_model', 'settings_required', 'error'] as const)('shows a dismissible warning for %s', state => {
    expect(modelStatusView(status(state, 1))).toMatchObject({ variant: 'warning', dismissible: true });
  });
});

describe('model status revision ownership', () => {
  it('reprocesses once when the snapshot already includes duplicate readiness events', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    const changes = change(status('unavailable', 1), status('ready', 2));
    coordinator.handleChanges(changes);
    coordinator.handleChanges(changes);
    coordinator.finishInitialLoad({ nativeModelStatus: status('ready', 2) });
    coordinator.handleChanges(changes);
    expect(processPosts).toHaveBeenCalledOnce();
  });
});
