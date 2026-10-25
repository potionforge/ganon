import { Clock } from '../ports/Clock';

export function nextVersion(lastKnown: number, clock?: Clock): number {
  const now = clock?.now() ?? Date.now();
  return Math.max(now, lastKnown + 1);
}
