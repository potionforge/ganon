import { ConflictResolutionStrategy } from './ConflictResolutionStrategy';
import { ConflictMergeStrategy } from './ConflictMergeStrategy';

/**
 * Configuration for handling data conflicts during sync operations.
 * Defines conflict resolution strategies, merge behavior, and notification settings.
 */
export interface ConflictResolutionConfig {
  /** Strategy to use when data conflicts are detected */
  strategy: ConflictResolutionStrategy;

  /** How to merge conflicting data when using merge strategies */
  mergeStrategy?: ConflictMergeStrategy;

  /** Whether to notify users when conflicts occur */
  notifyOnConflict: boolean;

  /** Whether to track conflicts for analytics */
  trackConflicts: boolean;

  /** Maximum number of conflicts to track before clearing old ones */
  maxTrackedConflicts?: number;
}
