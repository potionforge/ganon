import { Clock } from '../../ports/Clock';

export class FakeClock implements Clock {
  private currentTime = 0;

  now(): number {
    return this.currentTime;
  }

  set(time: number): void {
    this.currentTime = time;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }
}
