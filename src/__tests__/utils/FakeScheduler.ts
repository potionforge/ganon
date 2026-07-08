import { CancelHandle, Scheduler } from '../../ports/Scheduler';

interface ScheduledTask {
  fn: () => void;
  runAt: number;
  repeatMs?: number;
  cancelled: boolean;
  running: boolean;
}

export class FakeScheduler implements Scheduler {
  private tasks: ScheduledTask[] = [];
  private now = 0;

  schedule(fn: () => void, ms: number): CancelHandle {
    const task: ScheduledTask = { fn, runAt: this.now + ms, cancelled: false, running: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  repeat(fn: () => void, ms: number): CancelHandle {
    const task: ScheduledTask = {
      fn,
      runAt: this.now + ms,
      repeatMs: ms,
      cancelled: false,
      running: false,
    };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.schedule(() => resolve(), ms);
    });
  }

  advance(ms: number): void {
    this.now += ms;
    this.runDueTasks();
  }

  private runDueTasks(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = this.tasks
        .filter(t => !t.cancelled && !t.running && t.runAt <= this.now)
        .sort((a, b) => a.runAt - b.runAt);

      for (const task of due) {
        // Re-check eligibility: nested advances may reschedule or cancel tasks
        // still present in this pass's snapshot (especially repeating tasks).
        if (task.cancelled || task.running || task.runAt > this.now) continue;
        task.running = true;
        try {
          task.fn();
        } finally {
          task.running = false;
        }
        if (task.repeatMs !== undefined && !task.cancelled) {
          // Reschedule from completion (this.now after fn), not from the original
          // scheduled tick. A repeating callback that advances past its own next
          // tick drops that tick (running flag blocks re-entry; this line sets a
          // future runAt) — unlike jest fake timers, but prevents unbounded recursion.
          task.runAt = this.now + task.repeatMs;
        } else {
          task.cancelled = true;
        }
        progressed = true;
      }
    }
    this.tasks = this.tasks.filter(t => !t.cancelled);
  }
}
