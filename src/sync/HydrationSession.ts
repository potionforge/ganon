import IUserManager from '../models/interfaces/IUserManager';

/**
 * Captures the hydration generation at pass start.
 *
 * Two checks, intentionally distinct:
 * - isStale(): generation mismatch OR logged-out — gates remote→local writes.
 * - isCurrentGeneration(): generation match only — gates dedupe-handle lifecycle
 *   (finally / post-await result checks). Login state is deliberately excluded so a
 *   same-generation pass can clear hydrationPromise even if isUserLoggedIn() flips
 *   without a generation bump.
 */
export default class HydrationSession {
  constructor(
    private readonly capturedGeneration: number,
    private readonly getCurrentGeneration: () => number,
    private readonly userManager: IUserManager
  ) {}

  isStale(): boolean {
    return (
      this.capturedGeneration !== this.getCurrentGeneration() ||
      !this.userManager.isUserLoggedIn()
    );
  }

  isCurrentGeneration(): boolean {
    return this.capturedGeneration === this.getCurrentGeneration();
  }
}
