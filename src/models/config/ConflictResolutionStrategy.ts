/**
 * Strategies for resolving data conflicts during synchronization.
 * These define which data source should be used when conflicts are detected.
 */
export enum ConflictResolutionStrategy {
  /**
   * Use local data as the source of truth.
   * Local changes take precedence over remote changes.
   */
  LOCAL_WINS = 'local-wins',

  /**
   * Use remote data as the source of truth.
   * Remote changes take precedence over local changes.
   */
  REMOTE_WINS = 'remote-wins',

  /**
   * Use the data with the most recent modification timestamp.
   * The most recently modified data wins the conflict.
   */
  LAST_MODIFIED_WINS = 'last-modified-wins'
}
