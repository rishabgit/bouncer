/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { createModelLoadingCoordinator, modelStatusView } from '../../src/content/ui.js';
import type { LocalModelStatus } from '../../src/types.js';

const status = (state: LocalModelStatus['state'], revision: number): LocalModelStatus => ({ state, revision, message: '' });
const change = (oldValue: LocalModelStatus, newValue: LocalModelStatus) => ({ nativeModelStatus: { oldValue, newValue } });

describe('native status initialization', () => {
  it('replays recovery received before a stale initial read and processes posts once', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.handleChanges(change(status('error', 1), status('ready', 2)));
    expect(render).not.toHaveBeenCalled();
    coordinator.finishInitialLoad({ nativeModelStatus: status('error', 1) });
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(status('ready', 2));
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('uses event oldValue when the snapshot already contains the recovery event', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.handleChanges(change(status('not_connected', 1), status('ready', 2)));
    coordinator.finishInitialLoad({ nativeModelStatus: status('ready', 2) });
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('rejects an older queued event when the snapshot has a newer revision', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.handleChanges(change(status('error', 1), status('ready', 2)));
    coordinator.finishInitialLoad({ nativeModelStatus: status('blocked', 3) });
    expect(render).toHaveBeenLastCalledWith(status('blocked', 3));
    expect(processPosts).not.toHaveBeenCalled();
    coordinator.handleChanges(change(status('ready', 2), status('loading', 2)));
    expect(render).toHaveBeenCalledOnce();
  });

  it('does not reprocess posts on normal loading completion or unrelated events', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status('loading', 1) });
    coordinator.handleChanges(change(status('loading', 1), status('ready', 2)));
    coordinator.handleChanges({ filterReplies: { oldValue: true, newValue: false } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(processPosts).not.toHaveBeenCalled();
  });

  it.each(['paused', 'missing_model', 'blocked', 'recovery_required'] as const)('reprocesses eligible posts after %s recovers', state => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    coordinator.finishInitialLoad({ nativeModelStatus: status(state, 1) });
    coordinator.handleChanges(change(status(state, 1), status('ready', 2)));
    expect(processPosts).toHaveBeenCalledOnce();
  });
});

describe('native feed status', () => {
  it('keeps healthy loaded and unloaded readiness quiet', () => {
    expect(modelStatusView(status('ready', 1))).toBeNull();
    expect(modelStatusView(status('filtering', 2))).toBeNull();
  });
  it('shows loading without a made-up percentage or duration', () => {
    expect(modelStatusView(status('loading', 1))?.body).toBe('Loading Gemma for this request…');
  });
});
