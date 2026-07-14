export interface CancelHandle {
  cancel(): void;
}

export interface Scheduler {
  schedule(fn: () => void, ms: number): CancelHandle;
  repeat(fn: () => void, ms: number): CancelHandle;
  /** Promise-based delay for async batch gaps (e.g. ChunkManager). */
  delay(ms: number): Promise<void>;
}

export class SystemScheduler implements Scheduler {
  schedule(fn: () => void, ms: number): CancelHandle {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  }

  repeat(fn: () => void, ms: number): CancelHandle {
    const id = setInterval(fn, ms);
    // Node-only: don't hold test processes open; no-op in RN where setInterval returns a number.
    if (typeof id === 'object' && id !== null && 'unref' in id && typeof id.unref === 'function') {
      id.unref();
    }
    return { cancel: () => clearInterval(id) };
  }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }
}
