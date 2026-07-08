import { CancelHandle, Scheduler } from '../../ports/Scheduler';

interface ScheduledTask {
  fn: () => void;
  runAt: number;
  repeatMs?: number;
  cancelled: boolean;
}

export class FakeScheduler implements Scheduler {
  private tasks: ScheduledTask[] = [];
  private now = 0;

  schedule(fn: () => void, ms: number): CancelHandle {
    const task: ScheduledTask = { fn, runAt: this.now + ms, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  repeat(fn: () => void, ms: number): CancelHandle {
    const task: ScheduledTask = { fn, runAt: this.now + ms, repeatMs: ms, cancelled: false };
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
        .filter(t => !t.cancelled && t.runAt <= this.now)
        .sort((a, b) => a.runAt - b.runAt);

      for (const task of due) {
        if (task.cancelled) continue;
        task.fn();
        if (task.repeatMs !== undefined && !task.cancelled) {
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
