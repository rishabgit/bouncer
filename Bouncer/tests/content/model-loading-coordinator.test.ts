/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createModelLoadingCoordinator } from '../../src/content/ui.js';
import type { LocalModelStatus } from '../../src/types.js';

const modelStatus = (state: LocalModelStatus['state']): LocalModelStatus => ({ state });
const storageChange = (oldValue: unknown, newValue: unknown): chrome.storage.StorageChange => ({
  oldValue,
  newValue,
});

describe('createModelLoadingCoordinator', () => {
  it('replays a status event that arrives before a stale initial read resolves', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    const downloading = { qwen: modelStatus('downloading') };
    const ready = { qwen: modelStatus('ready') };

    coordinator.handleChanges({
      localModelStatuses: storageChange(downloading, ready),
    });
    expect(render).not.toHaveBeenCalled();

    coordinator.finishInitialLoad({
      selectedModel: 'local:qwen',
      localModelStatuses: downloading,
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(ready, 'local:qwen');
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('uses storage-event oldValue even when the initial snapshot already includes the event', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    const downloading = { qwen: modelStatus('downloading') };
    const ready = { qwen: modelStatus('ready') };

    coordinator.handleChanges({
      localModelStatuses: storageChange(downloading, ready),
    });
    coordinator.finishInitialLoad({
      selectedModel: 'local:qwen',
      localModelStatuses: ready,
    });

    expect(render).toHaveBeenCalledWith(ready, 'local:qwen');
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('applies selection before statuses when both change in one event', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    coordinator.finishInitialLoad({
      selectedModel: 'local:qwen',
      localModelStatuses: { qwen: modelStatus('ready'), gemma: modelStatus('cached') },
    });
    render.mockClear();

    coordinator.handleChanges({
      selectedModel: storageChange('local:qwen', 'local:gemma'),
      localModelStatuses: storageChange(
        { qwen: modelStatus('ready'), gemma: modelStatus('cached') },
        { qwen: modelStatus('cached'), gemma: modelStatus('ready') },
      ),
    });

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(
      { qwen: modelStatus('cached'), gemma: modelStatus('ready') },
      'local:gemma',
    );
    expect(processExistingPosts).toHaveBeenCalledOnce();
  });

  it('does not treat an unrelated progress update as a ready transition', () => {
    const render = vi.fn();
    const processExistingPosts = vi.fn();
    const coordinator = createModelLoadingCoordinator(render, processExistingPosts);
    coordinator.finishInitialLoad({
      selectedModel: 'local:qwen',
      localModelStatuses: { qwen: modelStatus('downloading') },
    });
    render.mockClear();

    coordinator.handleChanges({
      localModelStatuses: storageChange(
        { qwen: { ...modelStatus('downloading'), progress: 0.2 } },
        { qwen: { ...modelStatus('downloading'), progress: 0.4 } },
      ),
    });

    expect(render).toHaveBeenCalledOnce();
    expect(processExistingPosts).not.toHaveBeenCalled();
  });
});
