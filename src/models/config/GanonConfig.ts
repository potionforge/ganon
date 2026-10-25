import { LogLevel } from "../../utils/Log";
import { CloudBackupConfig } from "./CloudBackupConfig";
import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { IntegrityFailureConfig } from "./IntegrityFailureConfig";
import { ConflictResolutionConfig } from "./ConflictResolutionConfig";
import type { BackupResult } from "../sync/BackupResult";
import type { RestoreResult } from "../sync/RestoreResult";
import type { DigestReadMode } from "../../metadata/digest/selectRemoteDigest";

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
   * Whether to automatically start the sync interval and hydration on init/login,
   * and whether local metadata changes schedule remote legacy-map flushes.
   * When omitted, resolves to `true` via `resolveGanonConfig` (sync interval,
   * hydration, and metadata flush scheduling all enabled).
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

  /**
   * How remote digests are read during hydration and metadata fetch.
   * - 'legacy': remote_metadata map only
   * - 'dual': higher version across in-document digestMap and legacy map (default)
   * - 'v2': in-document digestMap only
   */
  digestReadMode?: DigestReadMode;

  /**
   * Guard writes while hydration is pending after login.
   * Only applies when user is logged in; guest writes are never blocked.
   */
  earlyWriteGuard?: 'off' | 'warn' | 'throw';

  /**
   * When true, debounced flushes write the legacy remote_metadata map (step 6.1 dual-write).
   * Defaults to true until step 6.3 sunset; set false only after fleet gate passes.
   */
  legacyMetadataWrites?: boolean;
}

/**
 * Internal config type used only when wiring Ganon → DependencyFactory → SyncEngine.
 * Extends the public config with event callbacks. Not part of the public API.
 */
export interface InternalGanonConfig<T extends BaseStorageMapping> extends GanonConfig<T> {
  eventCallbacks?: {
    onHydrationComplete?: (result: RestoreResult) => void;
    onSyncComplete?: (result: BackupResult) => void;
    onRestoreComplete?: (result: RestoreResult) => void;
  };
}
