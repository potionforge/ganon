/**
 * Strategies for handling integrity failures during sync operations.
 * These define how the system should recover when data integrity checks fail.
 */
export enum IntegrityFailureRecoveryStrategy {
  /**
   * Forces a metadata refresh by invalidating caches and re-fetching remote data.
   * Used when metadata is stale but data is correct.
   */
  FORCE_REFRESH = 'force-refresh',

  /**
   * Uses local data as the source of truth, ignoring integrity failures.
   * Useful when local data is trusted over remote data.
   */
  USE_LOCAL = 'use-local',

  /**
   * Uses remote data as the source of truth, replacing local data.
   * Useful when remote data is authoritative or local data is suspected to be corrupted.
   */
  USE_REMOTE = 'use-remote',

  /**
   * Skips the problematic key and continues with other operations.
   * Used when the data is not critical or can be handled later.
   */
  SKIP = 'skip'
}
