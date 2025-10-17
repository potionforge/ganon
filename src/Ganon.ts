import FirestoreManager from "./firestore/FirestoreManager";
import StorageManager from "./managers/StorageManager";
import NetworkMonitor from "./utils/NetworkMonitor";
import { GanonConfig } from "./models/config/GanonConfig";
import { IntegrityFailureConfig } from "./models/config/IntegrityFailureConfig";
import { IGanon } from "./models/interfaces/IGanon";
import { BaseStorageMapping } from "./models/storage/BaseStorageMapping";
import { BackupResult } from "./models/sync/BackupResult";
import { RestoreResult } from "./models/sync/RestoreResult";
import Log from "./utils/Log";
import SyncError, { SyncErrorType } from "./errors/SyncError";
import SyncController from "./sync/SyncController";
import DependencyFactory from "./factory/DependencyFactory";
import UserManager from "./managers/UserManager";
import { ConflictResolutionConfig } from "./models/config/ConflictResolutionConfig";

export default class Ganon<T extends Record<string, any> & BaseStorageMapping> implements IGanon<T> {
  private storageManager: StorageManager<T>;
  private syncController: SyncController<T>;
  private firestoreManager: FirestoreManager<T>;
  private networkMonitor: NetworkMonitor;
  private static unhandledRejectionHandlerSet = false;
  private userManager: UserManager<T>;
  private isDestroyed: boolean = false;
  private isInitialized: boolean = false;

  constructor(readonly config: GanonConfig<T>) {
    this._validateConfig(config);

    if (config.logLevel !== undefined) {
      Log.setLogLevel(config.logLevel);
    }

    // Set up global unhandled promise rejection handler (only once)
    if (!Ganon.unhandledRejectionHandlerSet) {
      this._setupGlobalErrorHandlers();
      Ganon.unhandledRejectionHandlerSet = true;
    }

    // Initialize all dependencies through the factory
    try {
      const dependencyFactory = new DependencyFactory<T>(config);
      const {
        storageManager,
        syncController,
        firestoreManager,
        networkMonitor,
        userManager,
      } = dependencyFactory.getDependencies();

      this.storageManager = storageManager;
      this.syncController = syncController;
      this.firestoreManager = firestoreManager;
      this.networkMonitor = networkMonitor;
      this.userManager = userManager;
      this.isInitialized = true;

      // Start sync if autoStartSync is enabled and user is logged in
      if (config.autoStartSync && this.isUserLoggedIn()) {
        this.startSync();
      }
    } catch (error) {
      Log.error(`Ganon: Failed to initialize components: ${error}`);
      throw new SyncError(
        `Failed to initialize Ganon: ${error}`,
        SyncErrorType.SyncConfigurationError
      );
    }
  }

  /**
   * Checks if a user is currently logged in.
   * @returns True if a user is logged in, false otherwise
   */
  isUserLoggedIn(): boolean {
    return this.userManager.isUserLoggedIn();
  }

  /**
   * Starts the automatic synchronization process with the cloud.
   */
  startSync(): void {
    this.syncController.startSyncInterval();
  }

  /**
   * Stops the automatic synchronization process with the cloud.
   */
  stopSync(): void {
    this.syncController.stopSyncInterval();
  }

  /**
   * Retrieves a value from storage by its key.
   * @param key - The key to retrieve the value for.
   * @returns The value associated with the key, or undefined if not found.
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.get(key);
  }

  /**
   * Sets a value in storage for a given key and marks it for synchronization if the key is configured in cloudConfig.
   * @param key - The key to set the value for.
   * @param value - The value to store.
   */
  set<K extends Extract<keyof T, string>>(key: K, value: T[K]): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.set(key, value);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncController.markAsPending(key);
    }
  }

  /**
   * Removes a value from storage by its key and marks it as deleted for synchronization if the key is configured in cloudConfig.
   * @param key - The key of the value to remove.
   */
  remove<K extends Extract<keyof T, string>>(key: K): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.remove(key);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncController.markAsDeleted(key);
    }
  }

  /**
   * Updates an existing value or creates a new one if it doesn't exist, and marks it for synchronization if the key is configured in cloudConfig.
   * @param key - The key to upsert the value for.
   * @param value - The partial value to store. Only the provided fields will be updated.
   */
  upsert<K extends Extract<keyof T, string>>(key: K, value: Partial<T[K]>): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this.storageManager.upsert(key, value);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncController.markAsPending(key);
    }
  }

  /**
   * Checks if a value exists in storage for a given key.
   * @param key - The key to check.
   * @returns True if the key exists in storage, false otherwise.
   */
  contains<K extends keyof T>(key: K): boolean {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.contains(key);
  }

  /**
   * Backup all data to the cloud.
   * @returns The backup result.
   * @throws {SyncError} Throws error if backup operation fails
   */
  async backup(): Promise<BackupResult> {
    Log.info('Ganon: Backing up all data to the cloud');
    try {
      return await this.syncController.syncAll();
    } catch (error) {
      if (error instanceof SyncError) {
        throw error; // Already properly typed error
      }
      throw new SyncError(
        `Backup operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Restore all data from the cloud.
   * @returns The restore result.
   * @throws {SyncError} Throws error if restore operation fails
   */
  async restore(): Promise<RestoreResult> {
    Log.info('Ganon: Restoring all data from the cloud');
    const result = await this.syncController.restore();
    Log.info(`✅ Ganon: Restored ${result.restoredKeys.length} keys`);
    if (result.failedKeys.length > 0) {
      Log.error(`❌ Ganon: Failed to restore ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
    }
    if (result.integrityFailures.length > 0) {
      Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
    }
    return result;
  }

  /**
   * Hydrates specific keys if remote is newer than local.
   * @param keys - Keys to hydrate (optional, defaults to all configured keys)
   * @param conflictConfig - Optional per-invocation conflict resolution configuration
   * @param integrityConfig - Optional per-invocation integrity failure configuration
   */
  async hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Hydrating data from the cloud');
    try {
      const result = await this.syncController.hydrate(keys, conflictConfig, integrityConfig);
      Log.info(`✅ Ganon: Hydrated ${result.restoredKeys.length} keys`);
      if (result.failedKeys.length > 0) {
        Log.error(`❌ Ganon: Failed to hydrate ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
      }
      if (result.integrityFailures.length > 0) {
        Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
      }
      return result;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Hydration operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Force hydrates specific keys regardless of version comparison.
   * This is useful for debugging and testing when you want to ensure fresh data.
   *
   * @param keys - Array of specific keys to force hydrate
   * @param conflictConfig - Optional per-invocation conflict resolution configuration
   * @param integrityConfig - Optional per-invocation integrity failure configuration.
   *                         If not provided, uses the global configuration from GanonConfig.
   *                         This allows different handling strategies for specific operations
   *                         (e.g., more aggressive retry on first login).
   * @returns The restore result containing information about the hydration operation.
   * @throws {SyncError} Throws error if hydration operation fails
   */
  async forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Force hydrating data from the cloud');
    try {
      const result = await this.syncController.forceHydrate(keys, conflictConfig, integrityConfig);
      Log.info(`✅ Ganon: Force hydrated ${result.restoredKeys.length} keys`);
      if (result.failedKeys.length > 0) {
        Log.error(`❌ Ganon: Failed to force hydrate ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
      }
      if (result.integrityFailures.length > 0) {
        Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
      }
      return result;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Force hydration operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Dangerously delete all data from the cloud.
   * WARNING: This operation cannot be undone!
   * @returns Promise that resolves when the operation is complete
   * @throws {SyncError} Throws error if delete operation fails
   */
  async dangerouslyDelete(): Promise<void> {
    Log.info('Ganon: Dangerously deleting all data from the cloud');
    try {
      return await this.firestoreManager.dangerouslyDelete();
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Dangerous delete operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Clear all data from the local storage.
   * @returns void
   */
  clearAllData(): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Clearing all data from local storage');
    try {
      this.storageManager.clearAllData();
    } catch (error) {
      Log.error(`Ganon: Failed to clear local data: ${error}`);
      throw new SyncError(
        `Failed to clear local data: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Sets the log level for Ganon operations.
   * @param logLevel - The log level to set
   */
  setLogLevel(logLevel: number): void {
    Log.setLogLevel(logLevel);
  }

  /**
   * Cleans up all resources used by Ganon.
   * This includes stopping sync, destroying the sync controller, and cleaning up the network monitor.
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    Log.info('Ganon: Destroying instance');
    try {
      // Stop sync if it's running
      this.stopSync();

      // Clean up components if they exist
      if (this.syncController) {
        this.syncController.destroy();
      }
      if (this.networkMonitor) {
        this.networkMonitor.destroy();
      }

      // Mark as destroyed
      this.isDestroyed = true;
    } catch (error) {
      Log.error(`Ganon: Error during cleanup: ${error}`);
      // Still mark as destroyed even if cleanup fails
      this.isDestroyed = true;
    }
  }

  /* P R I V A T E */

  /**
   * Checks if a key is configured for cloud synchronization
   * @param key - The key to check
   * @returns True if the key should be synced to the cloud
   */
  private _shouldSyncKey<K extends Extract<keyof T, string>>(key: K): boolean {
    if (!this.isInitialized || this.isDestroyed) {
      return false;
    }

    for (const docConfig of Object.values(this.config.cloudConfig)) {
      if (docConfig.docKeys?.includes(key) || docConfig.subcollectionKeys?.includes(key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sets up global error handlers to prevent app crashes from unhandled promise rejections.
   * This is called once per Ganon instance lifecycle.
   * @private
   */
  private _setupGlobalErrorHandlers(): void {
    // Only set up in React Native environment (not in Node.js test environment)
    if (typeof global !== 'undefined' && (global as any).ErrorUtils) {
      const originalHandler = (global as any).ErrorUtils.getGlobalHandler();

      (global as any).ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
        // Log the error through Ganon's logging system
        Log.error(`Ganon: Unhandled error caught: ${error.message}`);

        // Call the original handler if it exists
        if (originalHandler) {
          originalHandler(error, isFatal);
        }
      });
    }

    // Set up unhandled promise rejection handler
    if (typeof process !== 'undefined' && process.on) {
      process.on('unhandledRejection', (reason: any) => {
        Log.error(`Ganon: Unhandled promise rejection: ${reason}`);
        // Don't re-throw to prevent crash
      });
    }
  }

  private _validateConfig(config: GanonConfig<T>): void {
    if (!config) {
      throw new SyncError(
        'Ganon configuration is required',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate identifierKey
    if (!config.identifierKey || config.identifierKey.trim() === '') {
      throw new SyncError(
        'Ganon: identifierKey is required in config and cannot be empty',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate cloudConfig
    if (!config.cloudConfig) {
      throw new SyncError(
        'Ganon: cloudConfig is required in config',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate optional config properties
    if (config.syncInterval !== undefined && (typeof config.syncInterval !== 'number' || config.syncInterval < 0)) {
      throw new SyncError(
        'Ganon: syncInterval must be a positive number if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (config.autoStartSync !== undefined && typeof config.autoStartSync !== 'boolean') {
      throw new SyncError(
        'Ganon: autoStartSync must be a boolean if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (config.logLevel !== undefined && (typeof config.logLevel !== 'number' || config.logLevel < 0)) {
      throw new SyncError(
        'Ganon: logLevel must be a positive number if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    const cloudConfigEntries = Object.entries(config.cloudConfig);
    if (cloudConfigEntries.length === 0) {
      throw new SyncError(
        'Ganon: cloudConfig must contain at least one document configuration',
        SyncErrorType.SyncConfigurationError
      );
    }

    const allKeysInAllDocs = new Set<string>();
    const validDocNameRegex = /^[a-zA-Z0-9_-]+$/;

    for (const [docName, docConfig] of cloudConfigEntries) {
      // Validate document name
      if (!docName || !validDocNameRegex.test(docName)) {
        throw new SyncError(
          `Ganon: Document name "${docName}" is invalid. Document names must contain only letters, numbers, underscores, and hyphens.`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (!docConfig) {
        throw new SyncError(
          `Ganon: Document configuration for "${docName}" cannot be null or undefined`,
          SyncErrorType.SyncConfigurationError
        );
      }

      // Validate docKeys and subcollectionKeys types
      if (docConfig.docKeys && !Array.isArray(docConfig.docKeys)) {
        throw new SyncError(
          `Ganon: docKeys for document "${docName}" must be an array`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (docConfig.subcollectionKeys && !Array.isArray(docConfig.subcollectionKeys)) {
        throw new SyncError(
          `Ganon: subcollectionKeys for document "${docName}" must be an array`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (!docConfig.docKeys?.length && !docConfig.subcollectionKeys?.length) {
        throw new SyncError(
          `Ganon: Document "${docName}" must have either docKeys or subcollectionKeys defined`,
          SyncErrorType.SyncConfigurationError
        );
      }

      const allKeysInDoc = [...(docConfig.docKeys || []), ...(docConfig.subcollectionKeys || [])];
      const validKeyRegex = /^[a-zA-Z0-9_\-:]+$/;

      for (const key of allKeysInDoc) {
        // Validate key type
        if (typeof key !== 'string') {
          throw new SyncError(
            `Ganon: Key in document "${docName}" must be a string`,
            SyncErrorType.SyncConfigurationError
          );
        }

        // Validate key format
        if (!key || key.trim() === '') {
          throw new SyncError(
            `Ganon: Invalid key found in document "${docName}". Keys cannot be empty`,
            SyncErrorType.SyncConfigurationError
          );
        }

        if (!validKeyRegex.test(key)) {
          throw new SyncError(
            `Ganon: Key "${key}" in document "${docName}" is invalid. Keys must contain only letters, numbers, underscores, and hyphens.`,
            SyncErrorType.SyncConfigurationError
          );
        }

        // Check for duplicates
        if (allKeysInAllDocs.has(key)) {
          throw new SyncError(
            `Ganon: Duplicate key "${key}" found in document "${docName}". Keys must be unique across all documents.`,
            SyncErrorType.SyncConfigurationError
          );
        }
        allKeysInAllDocs.add(key);
      }
    }
  }
}
