import { LogLevel } from "../../utils/Log";
import { CloudBackupConfig } from "./CloudBackupConfig";
import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { IntegrityFailureConfig } from "./IntegrityFailureConfig";
import { ConflictResolutionConfig } from "./ConflictResolutionConfig";

/**
 * Main configuration interface for Ganon synchronization system.
 * Defines all settings needed to configure sync behavior, cloud backup,
 * integrity handling, and conflict resolution.
 */
export interface GanonConfig<T extends BaseStorageMapping> {
  /**
   * The key used to identify users/entities in the storage mapping.
   * This key must exist in the BaseStorageMapping type and is used for
   * user-specific data isolation and identification.
   */
  identifierKey: Extract<keyof T, string>;

  /**
   * Configuration for cloud backup operations, including document structure,
   * schema validation, and subcollection definitions.
   */
  cloudConfig: CloudBackupConfig<T>;

  /**
   * Whether to automatically start the sync interval on initialization.
   * If true, sync operations will run periodically based on syncInterval.
   * Default: true
   */
  autoStartSync?: boolean;

  /**
   * Logging level for the Ganon system.
   * Controls verbosity of log output (error, warn, info, verbose).
   */
  logLevel?: LogLevel;

  /**
   * Interval in milliseconds between automatic sync operations.
   * Determines how frequently pending operations are processed.
   * If not specified, uses DEFAULT_SYNC_INTERVAL constant.
   */
  syncInterval?: number;

  /**
   * Whether the remote Firestore should be treated as read-only.
   * When true, prevents write operations to the cloud, making it
   * a backup-only configuration.
   */
  remoteReadonly?: boolean;

  /**
   * Configuration for handling integrity failures during sync operations.
   * Defines retry behavior, recovery strategies, and notification settings.
   * If not specified, uses default values from _integrityFailureConfig.
   */
  integrityFailureConfig?: Partial<IntegrityFailureConfig>;

  /**
   * Configuration for handling data conflicts during sync operations.
   * Defines conflict resolution strategies, merge behavior, and notification settings.
   * If not specified, uses default values from _conflictResolutionConfig.
   */
  conflictResolutionConfig?: Partial<ConflictResolutionConfig>;
}