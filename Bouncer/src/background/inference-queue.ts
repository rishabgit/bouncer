// One request at a time; each finite task settles before the next starts.
export const STALE_WORK_ERROR = 'Stale work';

interface QueueTask {
  run: () => Promise<void>;
  reject: (reason: Error) => void;
}

export class InferenceQueue {
  private readonly _pending: QueueTask[] = [];
  private _processing = false;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._pending.push({ run: async () => { resolve(await fn()); }, reject });
      void this._process();
    });
  }

  clear(): void {
    for (const task of this._pending.splice(0)) task.reject(new Error(STALE_WORK_ERROR));
  }

  private async _process(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    try {
      while (this._pending.length) {
        const task = this._pending.shift()!;
        try { await task.run(); } catch (error) {
          task.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally { this._processing = false; }
  }
}
