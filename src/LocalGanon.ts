import StorageManager from "./managers/StorageManager";
import { IGanon } from "./models/interfaces/IGanon";
import { BaseStorageMapping } from "./models/storage/BaseStorageMapping";
import { BackupResult } from "./models/sync/BackupResult";
import { RestoreResult } from "./models/sync/RestoreResult";
import { ConflictResolutionConfig } from "./models/config/ConflictResolutionConfig";
import { IntegrityFailureConfig } from "./models/config/IntegrityFailureConfig";
import Log from "./utils/Log";
import SyncError, { SyncErrorType } from "./errors/SyncError";

/**
 * Simplified configuration for LocalGanon that only requires an identifier key
 */
export interface LocalGanonConfig {
  identifierKey: string;
  logLevel?: number;
}

/**
 * LocalGanon is a local storage-only version of Ganon that provides
 * the same interface but only implements local storage functionality.
 * All sync-related methods are logged but do nothing.
 */
export default class LocalGanon<T extends Record<string, any> & BaseStorageMapping> implements IGanon<T> {
  private storageManager: StorageManager<T>;
  private isDestroyed: boolean = false;

  constructor(readonly config: LocalGanonConfig) {
    this._validateConfig(config);

    if (config.logLevel !== undefined) {
      Log.setLogLevel(config.logLevel);
    }

    this.storageManager = new StorageManager<T>();
  }

  /**
   * Retrieves a value from storage by its key.
   * @param key - The key to retrieve the value for.
   * @returns The value associated with the key, or undefined if not found.
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.get(key);
  }

  /**
   * Sets a value in storage for a given key.
   * @param key - The key to set the value for.
   * @param value - The value to store.
   */
  set<K extends Extract<keyof T, string>>(key: K, value: T[K]): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.set(key, value);
  }

  /**
   * Removes a value from storage by its key.
   * @param key - The key of the value to remove.
   */
  remove<K extends Extract<keyof T, string>>(key: K): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.remove(key);
  }

  /**
   * Updates an existing value or creates a new one if it doesn't exist.
   * @param key - The key to upsert the value for.
   * @param value - The partial value to store. Only the provided fields will be updated.
   */
  upsert<K extends Extract<keyof T, string>>(key: K, value: Partial<T[K]>): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.upsert(key, value);
  }

  /**
   * Checks if a value exists in storage for a given key.
   * @param key - The key to check.
   * @returns True if the key exists in storage, false otherwise.
   */
  contains<K extends keyof T>(key: K): boolean {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.contains(key);
  }

  /**
   * Starts the automatic synchronization process with the cloud.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   */
  startSync(): void {
    Log.warn('LocalGanon: startSync() called but LocalGanon does not support cloud synchronization');
  }

  /**
   * Stops the automatic synchronization process with the cloud.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   */
  stopSync(): void {
    Log.warn('LocalGanon: stopSync() called but LocalGanon does not support cloud synchronization');
  }

  /**
   * Backup all data to the cloud.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   * @returns A mock backup result indicating no operation was performed.
   */
  async backup(): Promise<BackupResult> {
    Log.warn('LocalGanon: backup() called but LocalGanon does not support cloud synchronization');
    return {
      success: true,
      backedUpKeys: [],
      failedKeys: [],
      skippedKeys: [],
      timestamp: new Date()
    };
  }

  /**
   * Restore all data from the cloud.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   * @returns A mock restore result indicating no operation was performed.
   */
  async restore(): Promise<RestoreResult> {
    Log.warn('LocalGanon: restore() called but LocalGanon does not support cloud synchronization');
    return {
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date()
    };
  }

  /**
   * Hydrates local storage with remote data.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   * @param keys - Optional array of specific keys to hydrate.
   * @returns A mock restore result indicating no operation was performed.
   */
  async hydrate(_keys?: Extract<keyof T, string>[], _conflictConfig?: Partial<ConflictResolutionConfig>, _integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    Log.warn('LocalGanon: hydrate() called but LocalGanon does not support cloud synchronization');
    return {
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date()
    };
  }

  /**
   * Force hydrates specific keys regardless of version comparison.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   * @param keys - Array of specific keys to force hydrate.
   * @returns A mock restore result indicating no operation was performed.
   */
  async forceHydrate(_keys: Extract<keyof T, string>[], _conflictConfig?: Partial<ConflictResolutionConfig>, _integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    Log.warn('LocalGanon: forceHydrate() called but LocalGanon does not support cloud synchronization');
    return {
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date()
    };
  }

  /**
   * Dangerously delete all data from the cloud.
   * LOCAL ONLY: This method is logged but does nothing in LocalGanon.
   */
  async dangerouslyDelete(): Promise<void> {
    Log.warn('LocalGanon: dangerouslyDelete() called but LocalGanon does not support cloud synchronization');
  }

  /**
   * Clear all data from the local storage.
   */
  clearAllData(): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: LocalGanon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('LocalGanon: Clearing all data from local storage');
    this.storageManager.clearAllData();
  }

  /**
   * Sets the log level for LocalGanon operations.
   * @param logLevel - The log level to set
   */
  setLogLevel(logLevel: number): void {
    Log.setLogLevel(logLevel);
  }

  /**
   * Cleans up all resources used by LocalGanon.
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    Log.info('LocalGanon: Destroying instance');
    this.isDestroyed = true;
  }

  /* P R I V A T E */

  /**
   * Validates the LocalGanon configuration.
   * @param config - The configuration to validate
   */
  private _validateConfig(config: LocalGanonConfig): void {
    if (!config) {
      throw new SyncError(
        'LocalGanon configuration is required',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate identifierKey
    if (!config.identifierKey || config.identifierKey.trim() === '') {
      throw new SyncError(
        'LocalGanon: identifierKey is required in config and cannot be empty',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate optional config properties
    if (config.logLevel !== undefined && (typeof config.logLevel !== 'number' || config.logLevel < 0)) {
      throw new SyncError(
        'LocalGanon: logLevel must be a positive number if provided',
        SyncErrorType.SyncConfigurationError
      );
    }
  }
}
