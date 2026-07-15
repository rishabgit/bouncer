/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createModelLoadingCoordinator } from '../../src/content/ui.js';
import type { LocalModelStatus } from '../../src/types.js';

const modelStatus = (state: LocalModelStatus['state']): LocalModelStatus => ({ state });
const MODEL_ID = 'gemma-4-E2B-it-web';
const MODEL_KEY = `local:${MODEL_ID}`;
const storageChange = (oldValue: unknown, newValue: unknown): chrome.storage.StorageChange => ({
  oldValue,
  newValue,
});

describe('createModelLoadingCoordinator', () => {
  it('replays a status event that arrives before a stale initial read resolves', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    const downloading = { [MODEL_ID]: modelStatus('downloading') };
    const ready = { [MODEL_ID]: modelStatus('ready') };

    coordinator.handleChanges({
      localModelStatuses: storageChange(downloading, ready),
    });
    expect(render).not.toHaveBeenCalled();

    coordinator.finishInitialLoad({
      selectedModel: MODEL_KEY,
      localModelStatuses: downloading,
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(ready, MODEL_KEY);
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('uses storage-event oldValue even when the initial snapshot already includes the event', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    const downloading = { [MODEL_ID]: modelStatus('downloading') };
    const ready = { [MODEL_ID]: modelStatus('ready') };

    coordinator.handleChanges({
      localModelStatuses: storageChange(downloading, ready),
    });
    coordinator.finishInitialLoad({
      selectedModel: MODEL_KEY,
      localModelStatuses: ready,
    });

    expect(render).toHaveBeenCalledWith(ready, MODEL_KEY);
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('applies an E2B migration selection before statuses when both change in one event', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    coordinator.finishInitialLoad({
      selectedModel: 'local:retired-model',
      localModelStatuses: { 'retired-model': modelStatus('ready'), [MODEL_ID]: modelStatus('cached') },
    });
    render.mockClear();

    coordinator.handleChanges({
      selectedModel: storageChange('local:retired-model', MODEL_KEY),
      localModelStatuses: storageChange(
        { 'retired-model': modelStatus('ready'), [MODEL_ID]: modelStatus('cached') },
        { [MODEL_ID]: modelStatus('ready') },
      ),
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(
      { [MODEL_ID]: modelStatus('ready') },
      MODEL_KEY,
    );
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('does not treat an unrelated progress update as a ready transition', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    coordinator.finishInitialLoad({
      selectedModel: MODEL_KEY,
      localModelStatuses: { [MODEL_ID]: modelStatus('downloading') },
    });
    render.mockClear();

    coordinator.handleChanges({
      localModelStatuses: storageChange(
        { [MODEL_ID]: { ...modelStatus('downloading'), progress: 0.2 } },
        { [MODEL_ID]: { ...modelStatus('downloading'), progress: 0.4 } },
      ),
    });

    expect(render).toHaveBeenCalledOnce();
    expect(processExistingPosts).not.toHaveBeenCalled();
  });
});
