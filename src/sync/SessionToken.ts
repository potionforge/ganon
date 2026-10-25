import IUserManager from '../models/interfaces/IUserManager';

/** Generation used for persisted ops until re-stamped at processOperations run start. */
export const PERSISTED_OP_PLACEHOLDER_GENERATION = -1;

/**
 * Cross-session fence for outbound sync and remote→local hydration.
 *
 * Two checks, intentionally distinct:
 * - isStale(): generation mismatch OR logged-out OR userId mismatch — gates all I/O and
 *   post-await local writes.
 * - isCurrentGeneration(): generation match only — gates dedupe-handle lifecycle
 *   (finally / post-await result checks). Login state is deliberately excluded so a
 *   same-generation pass can clear hydrationPromise even if isUserLoggedIn() flips
 *   without a generation bump.
 *
 * Generation is in-memory only; persisted ops store userId and are re-stamped with the
 * run token at the start of processOperations.
 */
export default class SessionToken {
  constructor(
    private readonly capturedGeneration: number,
    readonly userId: string | null,
    private readonly getCurrentGeneration: () => number,
    private readonly userManager: IUserManager
  ) {}

  isStale(): boolean {
    if (this.capturedGeneration !== this.getCurrentGeneration()) {
      return true;
    }
    if (!this.userManager.isUserLoggedIn()) {
      return true;
    }
    // userId === null is the logged-out generation slot; skip user match (generation + login gate enough).
    if (this.userId !== null && this.userManager.getCurrentUser() !== this.userId) {
      return true;
    }
    return false;
  }

  isCurrentGeneration(): boolean {
    return this.capturedGeneration === this.getCurrentGeneration();
  }

  /** Loaded from MMKV before a live run token exists; always stale until re-stamped. */
  static persistedPlaceholder(userId: string): SessionToken {
    const stub = {
      getCurrentUser: () => undefined,
      isUserLoggedIn: () => false,
    } as IUserManager;
    return new SessionToken(PERSISTED_OP_PLACEHOLDER_GENERATION, userId, () => 0, stub);
  }

  /** Unit/integration tests only — not for production call sites. */
  static forTests(userId: string, userManager?: IUserManager): SessionToken {
    const um =
      userManager ??
      ({
        getCurrentUser: () => userId,
        isUserLoggedIn: () => true,
      } as IUserManager);
    return new SessionToken(0, userId, () => 0, um);
  }
}
