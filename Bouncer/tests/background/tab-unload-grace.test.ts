import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleNavigationUnload,
  TAB_NAVIGATION_UNLOAD_GRACE_MS,
} from '../../src/background/tab-unload-grace';

describe('navigation-triggered last-tab unload grace', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains the model when an X reload registers within the grace', () => {
    vi.useFakeTimers();
    let generation = 4;
    const unload = vi.fn();

    scheduleNavigationUnload(
      generation,
      expected => expected === generation,
      unload,
    );
    generation++;
    vi.advanceTimersByTime(TAB_NAVIGATION_UNLOAD_GRACE_MS);

    expect(unload).not.toHaveBeenCalled();
  });

  it('unloads after the grace when the tab really navigated away', () => {
    vi.useFakeTimers();
    const generation = 7;
    const unload = vi.fn();

    scheduleNavigationUnload(
      generation,
      expected => expected === generation,
      unload,
    );
    vi.advanceTimersByTime(TAB_NAVIGATION_UNLOAD_GRACE_MS - 1);
    expect(unload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(unload).toHaveBeenCalledOnce();
    expect(unload).toHaveBeenCalledWith(generation);
  });
});
