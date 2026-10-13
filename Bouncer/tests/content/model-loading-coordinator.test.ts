/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { createModelLoadingCoordinator, modelStatusView } from '../../src/content/ui.js';
import type { EngineSelection, LocalModelStatus } from '../../src/types.js';

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
    expect(modelStatusView(status('loading', 1))?.body).toBe('Loading Gemma in Ollama for this request…');
  });
});

const selectedStatus = (selection: EngineSelection, state: LocalModelStatus['state'], revision: number): LocalModelStatus => ({
  ...status(state, revision), engine: selection.engine, selectionRevision: selection.revision,
});

describe('selected engine status coordination', () => {
  const native: EngineSelection = { engine: 'ollama', revision: 7 };
  const browser: EngineSelection = { engine: 'litertlm', revision: 8 };

  it('orders status revisions only inside the selected engine and selection revision', () => {
    const render = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, vi.fn());
    coordinator.finishInitialLoad({ engineSelection: native, localModelStatus: selectedStatus(native, 'ready', 900) });
    coordinator.handleChanges({ engineSelection: { oldValue: native, newValue: browser }, localModelStatus: {
      oldValue: selectedStatus(native, 'ready', 900), newValue: selectedStatus(browser, 'needs_download', 1),
    } });
    expect(render).toHaveBeenLastCalledWith(selectedStatus(browser, 'needs_download', 1));
    coordinator.handleChanges({ localModelStatus: { newValue: selectedStatus(native, 'ready', 999) } });
    coordinator.handleChanges({ nativeModelStatus: { newValue: selectedStatus(native, 'ready', 1000) } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(coordinator.getSelection()).toEqual(browser);
  });

  it('rejects stale initial snapshots and late progress for an earlier choice of the same engine', () => {
    const render = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, vi.fn());
    coordinator.handleChanges({ engineSelection: { oldValue: native, newValue: browser } });
    coordinator.handleChanges({ localModelStatus: { newValue: selectedStatus(browser, 'downloading', 2) } });
    coordinator.finishInitialLoad({ engineSelection: native, localModelStatus: selectedStatus(native, 'ready', 500) });
    expect(render).toHaveBeenLastCalledWith(selectedStatus(browser, 'downloading', 2));
    const oldBrowser = { engine: 'litertlm', revision: 6 } as const;
    coordinator.handleChanges({ localModelStatus: { newValue: selectedStatus(oldBrowser, 'ready', 1000) } });
    expect(render).toHaveBeenCalledOnce();
  });

  it('never revives an older engine event over a snapshot with a newer committed choice', () => {
    const render = vi.fn();
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processPosts);
    coordinator.handleChanges({ engineSelection: { newValue: native }, localModelStatus: { newValue: selectedStatus(native, 'ready', 1000) } });
    coordinator.finishInitialLoad({ engineSelection: browser, localModelStatus: selectedStatus(browser, 'needs_download', 1) });
    expect(render).toHaveBeenLastCalledWith(selectedStatus(browser, 'needs_download', 1));
    expect(processPosts).not.toHaveBeenCalled();
  });

  it('reprocesses once after a selected download recovers, including a raced snapshot', () => {
    const processPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(vi.fn(), processPosts);
    const changes = { localModelStatus: { oldValue: selectedStatus(browser, 'needs_download', 1), newValue: selectedStatus(browser, 'ready', 2) } };
    coordinator.handleChanges(changes);
    coordinator.handleChanges(changes);
    coordinator.finishInitialLoad({ engineSelection: browser, localModelStatus: selectedStatus(browser, 'ready', 2) });
    coordinator.handleChanges(changes);
    expect(processPosts).toHaveBeenCalledOnce();
  });

  it('does not accept unscoped native fixtures once there is an explicit choice', () => {
    const render = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, vi.fn());
    coordinator.finishInitialLoad({ engineSelection: browser, localModelStatus: selectedStatus(browser, 'needs_download', 1) });
    coordinator.handleChanges({ localModelStatus: { newValue: status('ready', 999) } });
    expect(render).toHaveBeenCalledOnce();
  });

  it('shows preparing, switching and measured download progress distinctly', () => {
    const download = { ...selectedStatus(browser, 'downloading', 1), receivedBytes: 1_000_000_000, totalBytes: 2_000_000_000 };
    expect(modelStatusView(download, browser)?.body).toContain('50%');
    expect(modelStatusView(selectedStatus(browser, 'loading', 2), browser)?.body).toContain('Preparing');
    expect(modelStatusView(selectedStatus(browser, 'switching', 3), browser)?.body).toContain('previous request');
    expect(modelStatusView(selectedStatus(browser, 'ready', 4), browser)).toBeNull();
    expect(modelStatusView(selectedStatus(native, 'blocked', 999), browser)).toBeNull();
  });
});
