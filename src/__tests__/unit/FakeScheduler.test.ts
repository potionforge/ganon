import { CancelHandle } from '../../ports/Scheduler';
import { FakeScheduler } from '../utils/FakeScheduler';

describe('FakeScheduler', () => {
  it('does not re-enter a one-shot callback when it calls advance', () => {
    const scheduler = new FakeScheduler();
    let runs = 0;

    scheduler.schedule(() => {
      runs++;
      scheduler.advance(1);
    }, 10);

    scheduler.advance(10);
    expect(runs).toBe(1);
  });

  it('does not re-enter a repeating callback when it calls advance', () => {
    const scheduler = new FakeScheduler();
    let runs = 0;

    scheduler.repeat(() => {
      runs++;
      scheduler.advance(1);
    }, 10);

    scheduler.advance(10);
    expect(runs).toBe(1);
  });

  it('does not double-fire a co-due repeating task when a one-shot advances time', () => {
    const scheduler = new FakeScheduler();
    let bRuns = 0;

    scheduler.schedule(() => {
      scheduler.advance(1);
    }, 10);

    scheduler.repeat(() => {
      bRuns++;
    }, 10);

    scheduler.advance(10);
    expect(bRuns).toBe(1);
  });

  it('runs repeating callbacks again on a later advance', () => {
    const scheduler = new FakeScheduler();
    let runs = 0;

    scheduler.repeat(() => {
      runs++;
    }, 10);

    scheduler.advance(10);
    scheduler.advance(10);
    expect(runs).toBe(2);
  });

  describe('delay', () => {
    it('does not resolve until advance reaches runAt, then resolves on microtask', async () => {
      const scheduler = new FakeScheduler();
      let resolved = false;
      const pending = scheduler.delay(10).then(() => {
        resolved = true;
      });

      scheduler.advance(9);
      await Promise.resolve();
      expect(resolved).toBe(false);

      scheduler.advance(1);
      await Promise.resolve();
      expect(resolved).toBe(true);
      await pending;
    });
  });

  describe('cancel', () => {
    it('prevents a cancelled task from running and compacts it', () => {
      const scheduler = new FakeScheduler();
      let runs = 0;

      const handle = scheduler.schedule(() => {
        runs++;
      }, 10);
      handle.cancel();

      scheduler.advance(10);
      expect(runs).toBe(0);
    });

    it('does not reschedule a repeating task that cancels itself', () => {
      const scheduler = new FakeScheduler();
      let runs = 0;
      let handle!: CancelHandle;

      handle = scheduler.repeat(() => {
        runs++;
        handle.cancel();
      }, 10);

      scheduler.advance(10);
      expect(runs).toBe(1);

      scheduler.advance(10);
      expect(runs).toBe(1);
    });

    it('does not fire a co-due sibling cancelled during an earlier callback', () => {
      const scheduler = new FakeScheduler();
      let bRuns = 0;
      let bHandle!: CancelHandle;

      scheduler.schedule(() => {
        bHandle.cancel();
      }, 10);

      bHandle = scheduler.schedule(() => {
        bRuns++;
      }, 10);

      scheduler.advance(10);
      expect(bRuns).toBe(0);
    });
  });

  describe('progressed loop', () => {
    it('runs a zero-delay task scheduled during a callback in the same advance', () => {
      const scheduler = new FakeScheduler();
      let nestedRuns = 0;

      scheduler.schedule(() => {
        scheduler.schedule(() => {
          nestedRuns++;
        }, 0);
      }, 10);

      scheduler.advance(10);
      expect(nestedRuns).toBe(1);
    });
  });
});
