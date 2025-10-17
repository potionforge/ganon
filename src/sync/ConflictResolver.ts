import { ConflictResolutionStrategy } from "../models/config/ConflictResolutionStrategy";
import { ConflictMergeStrategy } from "../models/config/ConflictMergeStrategy";
import { ConflictInfo, ConflictResolutionResult } from "../models/sync/ConflictInfo";
import { SyncMetadata } from "../models/sync/SyncMetadata";
import LocalSyncMetadata from "../models/sync/LocalSyncMetadata";
import Log from "../utils/Log";

/**
 * Utility class for detecting and resolving data conflicts during synchronization.
 * This handles conflicts between local and remote data, separate from integrity failures.
 */
export class ConflictResolver {

  /**
   * Detects if there's a data conflict between local and remote values.
   * A conflict exists when:
   * 1. Both local and remote data exist
   * 2. The data content is different
   * 3. Both have been modified (different versions)
   */
  static detectConflict<T>(
    _key: Extract<keyof T, string>,
    localValue: T[Extract<keyof T, string>] | undefined,
    remoteValue: T[Extract<keyof T, string>] | undefined,
    localMetadata: LocalSyncMetadata,
    remoteMetadata: SyncMetadata
  ): boolean {
    // No conflict if either value is undefined/null
    if (localValue === undefined || remoteValue === undefined ||
        localValue === null || remoteValue === null) {
      return false;
    }

    // No conflict if values are identical
    if (this._deepEqual(localValue, remoteValue)) {
      return false;
    }

    // No conflict if only one side has been modified
    if (localMetadata.version === remoteMetadata.version) {
      return false;
    }

    // Conflict exists if both sides have been modified and content differs
    return true;
  }

  /**
   * Resolves a data conflict using the specified strategy.
   */
  static resolveConflict<T>(
    conflictInfo: ConflictInfo<T>,
    strategy: ConflictResolutionStrategy,
    mergeStrategy?: ConflictMergeStrategy
  ): ConflictResolutionResult<T> {
    try {
      Log.info(`Ganon: Resolving conflict for key ${conflictInfo.key} using strategy: ${strategy}`);

      let resolvedValue: T[Extract<keyof T, string>] | undefined;

      switch (strategy) {
        case ConflictResolutionStrategy.LOCAL_WINS:
          resolvedValue = conflictInfo.localValue;
          break;

        case ConflictResolutionStrategy.REMOTE_WINS:
          resolvedValue = conflictInfo.remoteValue;
          break;

        case ConflictResolutionStrategy.LAST_MODIFIED_WINS:
          // Use version as timestamp since it represents when the data was last modified
          const localLastModified = conflictInfo.localMetadata.version || 0;
          const remoteLastModified = conflictInfo.remoteMetadata.version || 0;
          resolvedValue = localLastModified > remoteLastModified
            ? conflictInfo.localValue
            : conflictInfo.remoteValue;
          break;

        default:
          throw new Error(`Unknown conflict resolution strategy: ${strategy}`);
      }

      // Apply merge strategy if specified and both values are objects
      if (mergeStrategy && this._areObjects(conflictInfo.localValue, conflictInfo.remoteValue)) {
        resolvedValue = this._mergeValues(
          conflictInfo.localValue as Record<string, unknown>,
          conflictInfo.remoteValue as Record<string, unknown>,
          mergeStrategy,
          strategy
        ) as T[Extract<keyof T, string>];
      }

      return {
        success: true,
        strategy,
        resolvedValue
      };

    } catch (error) {
      Log.error(`Ganon: Failed to resolve conflict for key ${conflictInfo.key}: ${error}`);
      return {
        success: false,
        strategy,
        resolvedValue: conflictInfo.localValue,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Performs deep equality check between two values.
   */
  private static _deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    if (a === null || b === null || a === undefined || b === undefined) {
      return a === b;
    }

    if (typeof a !== typeof b) return false;

    if (typeof a === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);

      if (aKeys.length !== bKeys.length) return false;

      for (const key of aKeys) {
        if (!bKeys.includes(key)) return false;
        if (!this._deepEqual(aObj[key], bObj[key])) return false;
      }

      return true;
    }

    return false;
  }

  /**
   * Checks if both values are objects (not arrays or primitives).
   */
  private static _areObjects(a: unknown, b: unknown): boolean {
    return typeof a === 'object' &&
           typeof b === 'object' &&
           a !== null &&
           b !== null &&
           !Array.isArray(a) &&
           !Array.isArray(b);
  }

  /**
   * Merges two object values using the specified merge strategy.
   */
  private static _mergeValues(
    localValue: unknown,
    remoteValue: unknown,
    mergeStrategy: ConflictMergeStrategy,
    resolutionStrategy: ConflictResolutionStrategy
  ): unknown {
    const local = localValue as Record<string, unknown>;
    const remote = remoteValue as Record<string, unknown>;

      switch (mergeStrategy) {
        case ConflictMergeStrategy.SHALLOW_MERGE:
          // For shallow merge, merge non-conflicting fields from both objects
          // but use resolution strategy for conflicting fields
          const merged = { ...local };
          for (const key in remote) {
            if (!(key in local)) {
              // Add non-conflicting fields from remote
              merged[key] = remote[key];
            } else if (resolutionStrategy === ConflictResolutionStrategy.LOCAL_WINS) {
              // Keep local value for conflicting fields
              merged[key] = local[key];
            } else {
              // Use remote value for conflicting fields
              merged[key] = remote[key];
            }
          }
          return merged;

        case ConflictMergeStrategy.DEEP_MERGE:
          return this._deepMerge(local, remote, resolutionStrategy);

        case ConflictMergeStrategy.FIELD_LEVEL:
          return this._fieldLevelMerge(local, remote);

        default:
          return local; // Fallback to local
      }
  }

  /**
   * Performs deep merge of two objects.
   */
  private static _deepMerge(local: Record<string, unknown>, remote: Record<string, unknown>, resolutionStrategy: ConflictResolutionStrategy): Record<string, unknown> {
    const result = { ...local };

    for (const key in remote) {
      if (remote.hasOwnProperty(key)) {
        if (this._areObjects(result[key], remote[key])) {
          result[key] = this._deepMerge(
            result[key] as Record<string, unknown>,
            remote[key] as Record<string, unknown>,
            resolutionStrategy
          );
        } else if (!(key in local)) {
          // Add fields that only exist in remote
          result[key] = remote[key];
               } else if (resolutionStrategy === ConflictResolutionStrategy.LOCAL_WINS) {
          // Keep local value for conflicting fields
          result[key] = local[key];
        } else {
          // Use remote value for conflicting fields
          result[key] = remote[key];
        }
      }
    }

    return result;
  }

  /**
   * Performs field-level merge, keeping local values for conflicting fields.
   */
  private static _fieldLevelMerge(local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
    const result = { ...remote };

    // Override with local values for fields that exist in both
    for (const key in local) {
      if (local.hasOwnProperty(key) && remote.hasOwnProperty(key)) {
        result[key] = local[key];
      }
    }

    return result;
  }
}
