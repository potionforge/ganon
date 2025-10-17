import { ConflictResolutionStrategy } from "../config/ConflictResolutionStrategy";
import { SyncMetadata } from "./SyncMetadata";
import LocalSyncMetadata from "./LocalSyncMetadata";

/**
 * Information about a data conflict that occurred during synchronization.
 * This is used for tracking, notification, and resolution purposes.
 */
export interface ConflictInfo<T> {
  /** The key that had a conflict */
  key: Extract<keyof T, string>;

  /** The local value that conflicted */
  localValue: T[Extract<keyof T, string>] | undefined;

  /** The remote value that conflicted */
  remoteValue: T[Extract<keyof T, string>] | undefined;

  /** Local metadata at time of conflict */
  localMetadata: LocalSyncMetadata;

  /** Remote metadata at time of conflict */
  remoteMetadata: SyncMetadata;

  /** The resolution strategy that was applied */
  resolutionStrategy: ConflictResolutionStrategy;

  /** The resolved value after conflict resolution */
  resolvedValue?: T[Extract<keyof T, string>];

  /** Timestamp when the conflict was detected */
  detectedAt: number;

  /** Timestamp when the conflict was resolved */
  resolvedAt?: number;

  /** Additional context about the conflict */
  context?: {
    /** The operation that triggered the conflict */
    operation: 'sync' | 'backup' | 'restore' | 'hydration';

    /** Whether this was a field-level conflict */
    fieldLevel?: boolean;

    /** The specific fields that conflicted (for field-level conflicts) */
    conflictingFields?: string[];
  };
}

/**
 * Result of a conflict resolution operation
 */
export interface ConflictResolutionResult<T = any> {
  /** Whether the conflict was successfully resolved */
  success: boolean;

  /** The strategy that was used to resolve the conflict */
  strategy: ConflictResolutionStrategy;

  /** The resolved value */
  resolvedValue?: T[Extract<keyof T, string>];

  /** Error message if resolution failed */
  error?: string;
}
