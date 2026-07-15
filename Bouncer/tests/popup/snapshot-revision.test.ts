import { describe, expect, it } from 'vitest';
import { SnapshotRevision } from '../../src/popup/index.js';

describe('SnapshotRevision', () => {
  it('accepts a snapshot when no newer storage event arrived', () => {
    const revision = new SnapshotRevision();
    const snapshot = revision.beginSnapshot();

    expect(revision.isCurrent(snapshot)).toBe(true);
  });

  it('rejects a stale snapshot after a storage event', () => {
    const revision = new SnapshotRevision();
    const snapshot = revision.beginSnapshot();

    revision.markEvent();

    expect(revision.isCurrent(snapshot)).toBe(false);
    expect(revision.isCurrent(revision.beginSnapshot())).toBe(true);
  });
});
