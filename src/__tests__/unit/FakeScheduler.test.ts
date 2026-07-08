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
});
