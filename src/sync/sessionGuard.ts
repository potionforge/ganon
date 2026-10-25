import Log from '../utils/Log';
import SessionToken from './SessionToken';

/** Thrown inside a Firestore transaction callback so pending writes are rolled back. */
export class StaleSessionAbort extends Error {
  constructor(public readonly site: string) {
    super(`Stale session at ${site}`);
    this.name = 'StaleSessionAbort';
  }
}

/** Non-transaction I/O: returns false when stale (caller skips the call; nothing issued yet). */
export function guardSessionBeforeIo(session: SessionToken, site: string): boolean {
  if (session.isStale()) {
    Log.info(`Ganon: aborted stale sync work (${site})`);
    return false;
  }
  return true;
}

/** Transaction I/O: throws so the adapter/fake discards buffered writes on rollback. */
export function requireSessionInTransaction(session: SessionToken, site: string): void {
  if (session.isStale()) {
    throw new StaleSessionAbort(site);
  }
}
