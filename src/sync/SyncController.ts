import StorageManager from "../managers/StorageManager";
import FirestoreManager from "../firestore/FirestoreManager";
import { ISyncController } from "../models/interfaces/ISyncController";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import { GanonConfig } from "../models/config/GanonConfig";
import { IntegrityFailureConfig } from "../models/config/IntegrityFailureConfig";
import { ConflictResolutionConfig } from "../models/config/ConflictResolutionConfig";
import { IntegrityFailureRecoveryStrategy } from "../models/config/IntegrityFailureRecoveryStrategy";
import { ConflictResolutionStrategy } from "../models/config/ConflictResolutionStrategy";
import { ConflictMergeStrategy } from "../models/config/ConflictMergeStrategy";
import { BATCH_SIZE, DEFAULT_SYNC_INTERVAL } from "../constants";
import OperationRepo from "./OperationRepo";
import Log from "../utils/Log";
import SetOperation from "./operations/SetOperation";
import DeleteOperation from "./operations/DeleteOperation";
import { BackupResult } from "../models/sync/BackupResult";
import { RestoreResult, IntegrityFailureInfo } from "../models/sync/RestoreResult";
import { ConflictInfo, ConflictResolutionResult } from "../models/sync/ConflictInfo";
import { SyncStatus } from "../models/sync/SyncStatus";
import { SyncMetadata } from "../models/sync/SyncMetadata";
import LocalSyncMetadata from "../models/sync/LocalSyncMetadata";
import MetadataManager from "../metadata/MetadataManager";
import computeHash from "../utils/computeHash";
import UserManager from "../managers/UserManager";
import { ConflictResolver } from "./ConflictResolver";

/**
 * Controller responsible for managing synchronization between local storage and Firestore.
 * Handles operations like backup, restore, and hydration of data.
 */
export default class SyncController<T extends BaseStorageMapping> implements ISyncController<T> {
  private syncInterval: NodeJS.Timeout | number | null = null;
  private hydrationPromise: Promise<RestoreResult> | null = null;
  private syncInProgress: boolean = false;

  // Debounce batching for markAsPending
  private _pendingMarkKeys: Set<Extract<keyof T, string>> = new Set();
  private _markDebounceTimer: NodeJS.Timeout | null = null;
  private readonly _MARK_DEBOUNCE_DELAY = 50; // ms

  // Per-invocation integrity config
  private _currentIntegrityConfig?: Partial<IntegrityFailureConfig>;

  // Per-invocation conflict resolution config
  private _currentConflictConfig?: Partial<ConflictResolutionConfig>;

  // Tracked conflicts for analytics
  private _trackedConflicts: ConflictInfo<T>[] = [];

  constructor(
    private storage: StorageManager<T>,
    private firestore: FirestoreManager<T>,
    private metadataManager: MetadataManager<T>,
    private operationRepo: OperationRepo<T>,
    private userManager: UserManager<T>,
    private config: GanonConfig<T>
  ) {
    Log.verbose('Ganon: SyncController.constructor');

    if (this.config.autoStartSync) {
      this.startSyncInterval();
    }

    if (this.userManager.isUserLoggedIn()) {
      this.hydrate();
    }
  }

  /**
   * Gets the integrity failure configuration with defaults
   */
  private get _integrityFailureConfig(): IntegrityFailureConfig {
    const defaults: IntegrityFailureConfig = {
      maxRetries: 3,
      retryDelay: 1000,
      strategy: IntegrityFailureRecoveryStrategy.USE_LOCAL,
      notifyOnFailure: true,
    };

    return { ...defaults, ...this.config.integrityFailureConfig };
  }

  /**
   * Gets the conflict resolution configuration with defaults
   */
  private get _conflictResolutionConfig(): ConflictResolutionConfig {
    const defaults: ConflictResolutionConfig = {
      strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS,
      mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
      notifyOnConflict: true,
      trackConflicts: true,
      maxTrackedConflicts: 100,
    };

    return { ...defaults, ...this.config.conflictResolutionConfig };
  }

  /**
   * Starts the automatic sync interval that periodically processes pending operations.
   * Uses the configured sync interval or falls back to DEFAULT_SYNC_INTERVAL.
   * If an interval is already running, this method does nothing.
   */
  startSyncInterval(): void {
    Log.verbose('Ganon: SyncController.startSyncInterval');
    if (this.syncInterval) {
      return;
    }

    const interval = setInterval(() => {
      this.syncPending();
    }, this.config.syncInterval || DEFAULT_SYNC_INTERVAL);

    // Only call unref() in Node.js environments (for tests)
    // In React Native, setInterval returns a number, not a Timer object
    if (typeof interval === 'object' && 'unref' in interval && typeof interval.unref === 'function') {
      interval.unref();
    }

    this.syncInterval = interval;
  }

  /**
   * Stops the automatic sync interval if one is running.
   * Logs a message when the interval is stopped.
   */
  stopSyncInterval(): void {
    Log.verbose('Ganon: SyncController.stopSyncInterval');
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      Log.info("Ganon: sync interval stopped");
    }
  }

  /**
   * Triggers processing of all pending operations.
   * This is called automatically by the sync interval, but can also be called manually.
   * If hydration is in progress, this call will be skipped and a sync will be triggered
   * automatically once hydration completes.
   */
  async syncPending(): Promise<void> {
    Log.info('Ganon: syncing pending operations');
    if (this.syncInProgress) {
      Log.info("Ganon: sync already in progress, skipping");
      return;
    }

    // If hydration is in progress, skip this sync attempt
    // Hydration will trigger a sync when it completes
    if (this.hydrationPromise) {
      Log.info("Ganon: hydration in progress, skipping sync. Will sync after hydration completes");
      return;
    }

    this.syncInProgress = true;
    try {
      const results = await this.operationRepo.processOperations();
      if (results && results.some(result => result.success)) {
        this._updateLocalLastBackup();
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Marks a key for synchronization as a set operation.
   * The operation will be processed during the next sync cycle.
   * @param key - The key to mark as pending for synchronization
   */
  markAsPending(key: Extract<keyof T, string>): void {
    Log.verbose(`Ganon: SyncController.markAsPending (debounced), key: ${String(key)}`);
    this._pendingMarkKeys.add(key);
    if (this._markDebounceTimer) {
      clearTimeout(this._markDebounceTimer);
    }
    this._markDebounceTimer = setTimeout(() => {
      const keys = Array.from(this._pendingMarkKeys);
      this._pendingMarkKeys.clear();
      keys.forEach((pendingKey) => {
        this._processMarkAsPending(pendingKey);
      });
    }, this._MARK_DEBOUNCE_DELAY);
  }

  private _processMarkAsPending(key: Extract<keyof T, string>): void {
    Log.verbose(`Ganon: SyncController._processMarkAsPending, key: ${String(key)}`);
    const currentValue = this.storage.get(key);

    // If the value is undefined, treat it as a deletion
    if (currentValue === undefined) {
      Log.info(`Ganon: key ${key} has undefined value, treating as deletion`);
      this.markAsDeleted(key);
      return;
    }

    const currentHash = computeHash(currentValue);
    const existingMetadata = this.metadataManager.get(key);
    Log.verbose(`Ganon: SyncController._processMarkAsPending, key: ${key}, existingMetadata: ${JSON.stringify(existingMetadata)}, currentHash: ${currentHash}`);
    
    if (!existingMetadata || existingMetadata.digest !== currentHash) {
      Log.info(`Ganon: marking operation as pending: ${key} (hash changed: ${existingMetadata?.digest} -> ${currentHash})`);
      
      // Update metadata immediately to reflect the current state
      // This ensures metadata is accurate even when autosync is disabled
      // Don't schedule remote sync if autosync is disabled
      const scheduleRemoteSync = this.config.autoStartSync !== false;
      
      // Call set asynchronously but don't await it to avoid blocking the debounced operation
      const setPromise = this.metadataManager.set(key, {
        syncStatus: SyncStatus.Pending,
        digest: currentHash,
        version: Date.now(), // Update version to reflect when data was modified
      }, scheduleRemoteSync);
      
      if (setPromise && typeof setPromise.catch === 'function') {
        setPromise.catch(error => {
          Log.error(`Ganon: Failed to update metadata for key ${key}: ${error}`);
        });
      }
      
      this.operationRepo.addOperation(
        key,
        new SetOperation(key, this.storage, this.firestore, this.metadataManager)
      );
    } else {
      Log.info(`Ganon: skipping operation for ${key} - no changes detected (hash: ${currentHash})`);
    }
  }

  /**
   * Marks a key for synchronization as a delete operation.
   * The operation will be processed during the next sync cycle.
   * @param key - The key to mark as deleted for synchronization
   */
  markAsDeleted(key: Extract<keyof T, string>): void {
    Log.verbose(`Ganon: SyncController.markAsDeleted, key: ${String(key)}`);

    // Get existing metadata
    const existingMetadata = this.metadataManager.get(key);

    // Only create delete operation if metadata exists and has a valid digest
    // If no metadata exists or digest is empty, the key was never synced so nothing to delete
    if (!existingMetadata || !existingMetadata.digest || existingMetadata.digest === '') {
      Log.info(`Ganon: skipping delete operation for ${key} - no remote data to delete (digest: ${existingMetadata?.digest || 'none'})`);
      return;
    }

    Log.info(`Ganon: marking operation as deleted: ${key} (existing digest: ${existingMetadata.digest})`);

    // Set sync status to Pending immediately when operation is queued
    this.metadataManager.updateSyncStatus(key, SyncStatus.Pending);

    this.operationRepo.addOperation(
      key,
      new DeleteOperation(key, this.storage, this.firestore, this.metadataManager)
    );
  }

  /**
   * Synchronizes all configured keys to Firestore.
   * This is a full backup operation that will attempt to sync every key,
   * regardless of its current sync status.
   *
   * @returns A BackupResult containing information about the sync operation
   * @throws Will throw if there's an ongoing hydration operation
   */
  async syncAll(): Promise<BackupResult> {
    Log.verbose('Ganon: SyncController.syncAll');
    try {
      if (this.hydrationPromise) {
        await this.hydrationPromise;
      }

      const allKeys = this._getAllConfiguredKeys();
      Log.info(`Ganon: syncing ${allKeys.length} keys`);

      // Track which keys were marked for sync
      const markedForSync = new Set<Extract<keyof T, string>>();

      for (const key of allKeys) {
        if (this.storage.contains(key)) {
          const currentValue = this.storage.get(key);
          const currentHash = computeHash(currentValue);
          const existingMetadata = this.metadataManager.get(key);

          // Only mark as pending if hash has changed or no metadata exists
          if (!existingMetadata || existingMetadata.digest !== currentHash) {
            this.markAsPending(key);
            markedForSync.add(key);
          }
        } else {
          const existingMetadata = this.metadataManager.get(key);
          // Only mark as deleted if metadata exists and has a valid digest
          if (existingMetadata && existingMetadata.digest && existingMetadata.digest !== '') {
            this.markAsDeleted(key);
            markedForSync.add(key);
          }
        }
      }

      const results = await this.operationRepo.processOperations();

      const successfulResults = results ? results.filter(result => result.success) : [];
      const backedUpKeys = successfulResults
        .map(result => result.key)
        .filter((key): key is Extract<keyof T, string> => key !== undefined);

      // Keys that were marked for sync but failed
      const failedKeys = Array.from(markedForSync).filter(key => !backedUpKeys.includes(key));

      // Keys that were never marked for sync (skipped)
      const skippedKeys = allKeys.filter(key => !markedForSync.has(key));

      Log.info(`✅ Ganon: syncAll completed for ${backedUpKeys.length} keys - ${failedKeys.length} failed - ${skippedKeys.length} skipped`);

      if (backedUpKeys.length > 0) {
        this._updateLocalLastBackup();
      }

      return {
        success: failedKeys.length === 0,
        backedUpKeys,
        failedKeys,
        skippedKeys,
        timestamp: new Date(),
      };
    } catch (error) {
      Log.error(`❌ Ganon: error syncing all keys: ${error}`);
      throw error;
    }
  }

  /**
   * Restores all data from Firestore to local storage.
   * This is a full restore operation that will overwrite local data with remote data
   * for all configured keys, regardless of their current state.
   *
   * @param integrityConfig - Optional per-invocation integrity failure configuration.
   *                         If not provided, uses the global configuration from GanonConfig.
   *                         This allows different handling strategies for specific operations
   *                         (e.g., more aggressive retry on first login).
   * @returns A RestoreResult containing information about the restore operation
   * @throws Will not throw, but will return a failed result if user is not logged in
   */
  async restore(): Promise<RestoreResult> {
    Log.verbose('Ganon: SyncController.restore');
    if (!this.userManager.isUserLoggedIn()) {
      Log.info("Ganon: skipping restore because user is not logged in");
      throw new Error("Restore operation failed: User is not logged in");
    }

    await this.metadataManager.hydrateMetadata();
    return this._processKeys(async (key) => {
      const value = await this.firestore.fetch(key);
      if (value !== undefined) {
        this.storage.set(key, value as T[Extract<keyof T, string>]);
        Log.info(`✅ Ganon: restored key ${key}`);
        return true;
      }
      return false;
    }, "restore");
  }

  /**
   * Hydrates local storage with remote data, but only for keys where the remote version
   * is newer than the local version. This is a selective update operation that preserves
   * local changes that are newer than the remote data.
   *
   * @param keys - Optional array of specific keys to hydrate. If omitted, all configured keys will be processed.
   * @param integrityConfig - Optional per-invocation integrity failure configuration.
   *                         If not provided, uses the global configuration from GanonConfig.
   *                         This allows different handling strategies for specific operations
   *                         (e.g., more aggressive retry on first login).
   * @returns A RestoreResult containing information about the hydration operation
   * @throws Will not throw, but will return a failed result if user is not logged in
   */
  async hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    Log.info('Ganon: hydrating...');
    if (!this.userManager.isUserLoggedIn()) {
      Log.info("Ganon: skipping hydrate because user is not logged in");
      return this._emptyRestoreResult;
    }

    // If hydration is already in progress, return the existing promise
    if (this.hydrationPromise) {
      Log.info("Ganon: hydration already in progress, returning existing promise");
      return this.hydrationPromise;
    }

    try {
      this.hydrationPromise = this._processKeys(async (key) => {
        const needsHydration = await this.metadataManager.needsHydration(key);

        if (needsHydration) {
          const remoteValue = await this.firestore.fetch(key);
          if (remoteValue !== undefined) {
            const remoteComputedDigest = computeHash(remoteValue);
            // For hydration, we want to get remote metadata without syncing local changes
            let remoteMetadata = await this.metadataManager.getRemoteMetadataOnly(key);
            if (!remoteMetadata) {
              Log.warn(`Ganon: No remote metadata for key ${key}, skipping hydration`);
              return true; // No metadata means nothing to compare; consider this a success
            }

            /* C O N F L I C T S */
            const localMetadata = this.metadataManager.get(key);
            const localValue = this.storage.get(key);

            // Detect and resolve conflicts before hydration
            const hasConflict = localMetadata && ConflictResolver.detectConflict<T>(
              key,
              localValue,
              remoteValue as T[Extract<keyof T, string>] | undefined,
              localMetadata,
              remoteMetadata
            );

            if (hasConflict) {
              const config = { ...this._conflictResolutionConfig, ...this._currentConflictConfig };
              const resolution = ConflictResolver.resolveConflict<T>({
                key,
                localValue: this.storage.get(key),
                remoteValue: remoteValue as T[Extract<keyof T, string>] | undefined,
                localMetadata,
                remoteMetadata,
                resolutionStrategy: config.strategy,
                detectedAt: Date.now()
              }, config.strategy, config.mergeStrategy);

              if (resolution.success) {
                // Apply resolved value and update metadata
                this.storage.set(key, resolution.resolvedValue!);

                // Update metadata to reflect the resolved state
                const resolvedHash = computeHash(resolution.resolvedValue!);
                await this.metadataManager.set(key, {
                  syncStatus: SyncStatus.Synced,
                  digest: resolvedHash,
                  version: Date.now(),
                }, false); // Don't schedule remote sync during hydration

                Log.info(`✅ Ganon: hydrated key ${key} with resolved value (conflict resolved)`);
                return true; // Skip integrity checks since we've resolved the conflict
              } else {
                Log.warn(`Ganon: Conflict resolution failed for key ${key}, skipping`);
                return false;
              }
            }

            /* I N T E G R I T Y */
            if (remoteMetadata && remoteMetadata.digest === remoteComputedDigest) {
              Log.info(`Ganon: Metadata sync successful on first attempt for key ${key}`);
            } else {
              // Retry logic with integrity failure handling
              const config = { ...this._integrityFailureConfig, ...this._currentIntegrityConfig };

              for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
                const refreshedMetadata = await this.metadataManager.getRemoteMetadataOnly(key);
                if (refreshedMetadata && refreshedMetadata.digest === remoteComputedDigest) {
                  Log.info(`Ganon: Metadata sync successful on attempt ${attempt} for key ${key}`);
                  remoteMetadata = refreshedMetadata; // Update remoteMetadata with the refreshed version
                  break;
                }

                if (attempt === config.maxRetries) {
                  // Use the new integrity failure handling
                  const result = await this._handleIntegrityFailure(
                    key,
                    remoteComputedDigest,
                    remoteMetadata?.digest || 'unknown',
                    attempt,
                    this._currentIntegrityConfig
                  );

                  if (result.success) {
                    Log.info(`✅ Ganon: Integrity failure recovery successful for key ${key} using strategy: ${result.recoveryStrategy}`);
                    // Recovery was successful, skip the final integrity check since data is already stored
                    return true;
                  } else {
                    Log.error(`❌ Ganon: Persistent integrity failure for key ${key} after ${attempt} attempts. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
                    return false;
                  }
                }

                Log.warn(`Ganon: Retry ${attempt} for key ${key}. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
              }
            }

            // Only store the data if we have valid remote metadata and the integrity check passed
            if (remoteMetadata && remoteComputedDigest === remoteMetadata.digest) {
              this.storage.set(key, remoteValue as T[Extract<keyof T, string>]);
              await this.metadataManager.set(key, {
                syncStatus: SyncStatus.Synced,
                digest: remoteMetadata.digest,
                version: remoteMetadata.version,
              }, false); // Don't schedule remote sync during hydration
              Log.info(`✅ Ganon: hydrated key ${key} with hash ${remoteComputedDigest}`);
              return true;
            } else {
              // Integrity check failed - this should not happen as we check earlier, but log it anyway
              Log.error(`❌ Ganon: Cannot hydrate key ${key} - integrity check failed. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
              return false;
            }
          }
        }
        return false;
      }, "hydrate", keys, integrityConfig, conflictConfig);

      const result = await this.hydrationPromise;

      // After hydration completes, trigger a sync if there are pending operations
      if (this.hasPendingOperations()) {
        Log.info("Ganon: hydration complete, triggering sync for pending operations");
        // Use setTimeout to ensure this happens after the current hydration promise resolves
        setTimeout(() => this.syncPending(), 0);
      }

      return result;
    } catch (error) {
      Log.error(`Ganon: error hydrating data from Firestore: ${error}`);
      throw error;
    } finally {
      this.hydrationPromise = null;
    }
  }

  /**
   * Force hydrates specific keys regardless of version comparison.
   * This bypasses the needsHydration check and forces fresh data from the cloud.
   *
   * @param keys - Array of specific keys to force hydrate
   * @param integrityConfig - Optional per-invocation integrity failure configuration.
   *                         If not provided, uses the global configuration from GanonConfig.
   *                         This allows different handling strategies for specific operations
   *                         (e.g., more aggressive retry on first login).
   * @returns A RestoreResult containing information about the hydration operation
   * @throws Will not throw, but will return a failed result if user is not logged in
   */
  async forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    Log.info('Ganon: force hydrating...');
    if (!this.userManager.isUserLoggedIn()) {
      Log.info("Ganon: skipping force hydrate because user is not logged in");
      return this._emptyRestoreResult;
    }

    // If hydration is already in progress, return the existing promise
    if (this.hydrationPromise) {
      Log.info("Ganon: hydration already in progress, returning existing promise");
      return this.hydrationPromise;
    }

    try {
      this.hydrationPromise = this._processKeys(async (key) => {
        // Force cache invalidation to ensure fresh remote metadata
        await this.metadataManager.invalidateCacheForHydration(key);

        const remoteValue = await this.firestore.fetch(key);
        if (remoteValue !== undefined) {
          const remoteComputedDigest = computeHash(remoteValue);
          let remoteMetadata = await this.metadataManager.getRemoteMetadataOnly(key);

          // If no remote metadata is available, skip hydration but return success
          if (!remoteMetadata) {
            Log.warn(`Ganon: No remote metadata available for key ${key}, skipping hydration`);
            return true;
          }

          const localMetadata = this.metadataManager.get(key);
          const hasConflict = localMetadata && remoteMetadata && ConflictResolver.detectConflict<T>(
            key,
            this.storage.get(key),
            remoteValue as T[Extract<keyof T, string>] | undefined,
            localMetadata,
            remoteMetadata
          );

          if (hasConflict) {
            const resolution = ConflictResolver.resolveConflict<T>({
              key,
              localValue: this.storage.get(key),
              remoteValue: remoteValue as T[Extract<keyof T, string>] | undefined,
              localMetadata,
              remoteMetadata,
              resolutionStrategy: this._conflictResolutionConfig.strategy,
              detectedAt: Date.now()
            }, this._conflictResolutionConfig.strategy, this._conflictResolutionConfig.mergeStrategy);

            if (resolution.success) {
              this.storage.set(key, resolution.resolvedValue!);
            } else {
              Log.warn(`Ganon: Conflict resolution failed for key ${key}, skipping`);
              return false;
            }
          }

          if (remoteMetadata && remoteMetadata.digest === remoteComputedDigest) {
            Log.info(`Ganon: Metadata sync successful on attempt 1 for key ${key}`);
          } else {
            const config = { ...this._integrityFailureConfig, ...this._currentIntegrityConfig };

            for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
              const refreshedMetadata = await this.metadataManager.getRemoteMetadataOnly(key);
              if (refreshedMetadata && refreshedMetadata.digest === remoteComputedDigest) {
                Log.info(`Ganon: Metadata sync successful on attempt ${attempt} for key ${key}`);
                remoteMetadata = refreshedMetadata; // Update remoteMetadata with the refreshed version
                break;
              }

              if (attempt === config.maxRetries) {
                // Use the new integrity failure handling
                const result = await this._handleIntegrityFailure(
                  key,
                  remoteComputedDigest,
                  remoteMetadata?.digest || 'unknown',
                  attempt,
                  this._currentIntegrityConfig
                );

                if (result.success) {
                  Log.info(`Ganon: Integrity failure recovery successful for key ${key} using strategy: ${result.recoveryStrategy}`);
                  // Continue with the hydration process
                  break;
                } else {
                  Log.error(`❌ Ganon: Persistent integrity failure for key ${key} after ${attempt} attempts. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
                  return false;
                }
              }

              Log.warn(`Ganon: Retry ${attempt} for key ${key}. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
            }
          }

          // Only store the data if we have valid remote metadata and the integrity check passed
          if (remoteMetadata && remoteComputedDigest === remoteMetadata.digest) {
            this.storage.set(key, remoteValue as T[Extract<keyof T, string>]);
            await this.metadataManager.set(key, {
              syncStatus: SyncStatus.Synced,
              digest: remoteMetadata.digest,
              version: remoteMetadata.version,
            });
            Log.info(`✅ Ganon: force hydrated key ${key} with hash ${remoteComputedDigest}`);
            return true;
          } else {
            // Integrity check failed - this should not happen as we check earlier, but log it anyway
            Log.error(`❌ Ganon: Cannot hydrate key ${key} - integrity check failed. Computed: ${remoteComputedDigest}, Remote: ${remoteMetadata?.digest}`);
            return false;
          }
        }
        return false;
      }, "force hydrate", keys, integrityConfig, conflictConfig);

      const result = await this.hydrationPromise;

      // After hydration completes, trigger a sync if there are pending operations
      if (this.hasPendingOperations()) {
        Log.info("Ganon: force hydration complete, triggering sync for pending operations");
        // Use setTimeout to ensure this happens after the current hydration promise resolves
        setTimeout(() => this.syncPending(), 0);
      }

      return result;
    } catch (error) {
      Log.error(`Ganon: error force hydrating data from Firestore: ${error}`);
      throw error;
    } finally {
      this.hydrationPromise = null;
    }
  }

  /**
   * Gets the current sync status for a specific key.
   * @param key - The key to get the sync status for
   * @returns The sync status of the key, or undefined if not found
   */
  getSyncStatus(key: Extract<keyof T, string>): SyncStatus | undefined {
    Log.verbose(`Ganon: SyncController.getSyncStatus, key: ${String(key)}`);
    const metadata = this.metadataManager.get(key);
    return metadata?.syncStatus;
  }

  /**
   * Gets all keys that currently have a specific sync status.
   * @param status - The sync status to filter by
   * @returns Array of keys that have the specified sync status
   */
  getKeysByStatus(status: SyncStatus): Extract<keyof T, string>[] {
    Log.verbose(`Ganon: SyncController.getKeysByStatus, status: ${status}`);
    const allKeys = this._getAllConfiguredKeys();
    return allKeys.filter(key => {
      const metadata = this.metadataManager.get(key);
      return metadata?.syncStatus === status;
    });
  }

  /**
   * Gets a summary of sync statuses across all configured keys.
   * @returns Object with counts for each sync status
   */
  getSyncStatusSummary(): Record<SyncStatus, number> {
    Log.verbose('Ganon: SyncController.getSyncStatusSummary');
    const summary = {
      [SyncStatus.Pending]: 0,
      [SyncStatus.InProgress]: 0,
      [SyncStatus.Synced]: 0,
      [SyncStatus.Failed]: 0,
      [SyncStatus.Conflict]: 0,
    };

    const allKeys = this._getAllConfiguredKeys();
    allKeys.forEach(key => {
      const metadata = this.metadataManager.get(key);
      if (metadata?.syncStatus) {
        summary[metadata.syncStatus]++;
      }
    });

    return summary;
  }

  /**
   * Checks if there are any operations currently pending or in progress.
   * @returns True if sync operations are ongoing
   */
  hasPendingOperations(): boolean {
    Log.verbose('Ganon: SyncController.hasPendingOperations');
    const allKeys = this._getAllConfiguredKeys();
    return allKeys.some(key => {
      const status = this.getSyncStatus(key);
      return status === SyncStatus.Pending || status === SyncStatus.InProgress;
    });
  }

  /**
   * Cleans up all resources used by the sync controller.
   * This includes stopping the sync interval and clearing any pending operations.
   */
  destroy(): void {
    Log.verbose('Ganon: SyncController.destroy');
    this.stopSyncInterval();
    this.operationRepo.clearAll();
  }

  /**
   * Cancel all pending sync operations, typically called on user logout
   */
  cancelPendingOperations(): void {
    Log.verbose('Ganon: SyncController.cancelPendingOperations');
    // Cancel pending metadata sync operations
    this.metadataManager.cancelPendingOperations();

    // Clear pending operations from the operation repo
    this.operationRepo.clearAll();
  }

  /* P R I V A T E */

  /**
   * Updates the last backup timestamp in local storage.
   */
  private _updateLocalLastBackup(): void {
    Log.verbose('Ganon: SyncController._updateLocalLastBackup');
    this.storage.set('lastBackup' as Extract<keyof T, string>, Date.now() as T[Extract<keyof T, string>]);
  }
  /**
   * Internal method that processes keys in batches, handling the common logic for both
   * restore and hydrate operations. This method:
   *
   * 1. Processes keys in batches of BATCH_SIZE for efficiency
   * 2. Handles errors for individual keys without failing the entire operation
   * 3. Tracks successful and failed operations
   * 4. Provides consistent logging and result formatting
   *
   * The key difference between restore and hydrate operations is determined by the
   * processKey function passed to this method:
   * - restore: Always processes the key
   * - hydrate: Only processes if remote version is newer than local version
   *
   * @param processKey - Async function that processes a single key and returns whether it was restored
   * @param operation - String identifier for the operation (e.g., "restore", "hydrate") used in logging
   * @param keys - Optional array of specific keys to process. If omitted, all configured keys will be processed.
   * @returns A RestoreResult containing information about the operation
   *
   * @example
   * // For restore operation:
   * _processKeys(async (key) => {
   *   const value = await firestore.fetch(key);
   *   if (value) {
   *     storage.set(key, value);
   *     return true;
   *   }
   *   return false;
   * }, "restore");
   *
   * @example
   * // For hydrate operation:
   * _processKeys(async (key) => {
   *   const remoteMetadata = await firestore.getRemoteMetadata(key);
   *   const localMetadata = metadataManager.get(key);
   *   if (remoteMetadata?.version > localMetadata?.version) {
   *     // ... process key
   *     return true;
   *   }
   *   return false;
   * }, "hydrate");
   */
  private async _processKeys(
    processKey: (key: Extract<keyof T, string>) => Promise<boolean>,
    operation: string,
    keys?: Extract<keyof T, string>[],
    integrityConfig?: Partial<IntegrityFailureConfig>,
    conflictConfig?: Partial<ConflictResolutionConfig>
  ): Promise<RestoreResult> {
    Log.verbose(`Ganon: SyncController._processKeys, operation: ${operation}`);
    const restoredKeys: Extract<keyof T, string>[] = [];
    const failedKeys: Extract<keyof T, string>[] = [];
    const integrityFailures: IntegrityFailureInfo[] = [];

    // Store the per-invocation configs for use in integrity failure and conflict handling
    this._currentIntegrityConfig = integrityConfig;
    this._currentConflictConfig = conflictConfig;

    const keysToProcess = keys || this._getAllConfiguredKeys();

    for (let i = 0; i < keysToProcess.length; i += BATCH_SIZE) {
      const batch = keysToProcess.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (key) => {
        try {
          const wasRestored = await processKey(key);
          if (wasRestored) {
            restoredKeys.push(key);
          }
        } catch (error) {
          Log.error(`Ganon: error ${operation}ing key ${key}: ${error}`);
          failedKeys.push(key);
        }
      });

      await Promise.allSettled(batchPromises);
    }

    Log.info(`✅ Ganon: ${operation}d ${restoredKeys.length} keys`);
    if (failedKeys.length > 0) {
      Log.info(`❌ Ganon: ${failedKeys.length} keys failed to ${operation}: ${failedKeys.join(', ')}`);
    }
    if (integrityFailures.length > 0) {
      Log.info(`⚠️ Ganon: ${integrityFailures.length} keys had integrity failures: ${integrityFailures.map(f => f.key).join(', ')}`);
    }

    return {
      success: failedKeys.length === 0 && integrityFailures.length === 0,
      timestamp: new Date(),
      restoredKeys,
      failedKeys,
      integrityFailures,
    };
  }

  /**
   * Returns an empty restore result, used when operations cannot be performed
   * (e.g., when user is not logged in).
   */
  private get _emptyRestoreResult(): RestoreResult {
    Log.verbose('Ganon: SyncController._emptyRestoreResult');
    return {
      success: false,
      timestamp: new Date(),
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
    };
  }

  /**
   * Gets all keys that are configured for synchronization.
   * This includes both document keys and subcollection keys from the cloud configuration.
   *
   * @returns Array of all configured keys
   */
  private _getAllConfiguredKeys(): Extract<keyof T, string>[] {
    Log.verbose('Ganon: SyncController._getAllConfiguredKeys');
    const keys = new Set<Extract<keyof T, string>>();

    Object.values(this.firestore.cloudConfig).forEach(docConfig => {
      [...(docConfig.docKeys || []), ...(docConfig.subcollectionKeys || [])].forEach(key =>
        keys.add(key)
      );
    });

    return Array.from(keys);
  }

  /**
   * Handles integrity failures with configurable recovery strategies
   */
  private async _handleIntegrityFailure(
    key: Extract<keyof T, string>,
    computedHash: string,
    remoteHash: string,
    attempts: number,
    integrityConfig?: Partial<IntegrityFailureConfig>
  ): Promise<{ success: boolean; recoveryStrategy?: string }> {
    const integrityFailure: IntegrityFailureInfo = {
      key,
      computedHash,
      remoteHash,
      attempts,
    };

    const config = { ...this._integrityFailureConfig, ...integrityConfig };
    integrityFailure.recoveryStrategy = config.strategy;

    // Notify about the failure if configured
    if (config.notifyOnFailure) {
      this._notifyIntegrityFailure(integrityFailure);
    }

    // Track the failure for monitoring
    this._trackIntegrityFailure(integrityFailure);

    // Apply recovery strategy
    switch (config.strategy) {
      case IntegrityFailureRecoveryStrategy.FORCE_REFRESH:
        return await this._forceMetadataRefresh(key);
      case IntegrityFailureRecoveryStrategy.USE_LOCAL:
        return await this._useLocalData(key);
      case IntegrityFailureRecoveryStrategy.USE_REMOTE:
        return await this._useRemoteDataDespiteIntegrityFailure(key);
      case IntegrityFailureRecoveryStrategy.SKIP:
        Log.warn(`Skipping key ${key} due to integrity failure`);
        return { success: false, recoveryStrategy: IntegrityFailureRecoveryStrategy.SKIP };
      default:
        return { success: false, recoveryStrategy: 'none' };
    }
  }

  /**
   * Handles data conflicts with configurable resolution strategies.
   * This is separate from integrity failures and handles content conflicts.
   */
  private async _handleDataConflict(
    key: Extract<keyof T, string>,
    localValue: T[Extract<keyof T, string>] | undefined,
    remoteValue: T[Extract<keyof T, string>] | undefined,
    localMetadata: LocalSyncMetadata,
    remoteMetadata: SyncMetadata,
    conflictConfig?: Partial<ConflictResolutionConfig>
  ): Promise<ConflictResolutionResult<T>> {
    const config = { ...this._conflictResolutionConfig, ...conflictConfig };

    // Create conflict info
    const conflictInfo: ConflictInfo<T> = {
      key,
      localValue,
      remoteValue,
      localMetadata,
      remoteMetadata,
      resolutionStrategy: config.strategy,
      detectedAt: Date.now(),
      context: {
        operation: 'sync'
      }
    };

    // Notify about the conflict if configured
    if (config.notifyOnConflict) {
      this._notifyConflict(conflictInfo);
    }

    // Track the conflict for analytics
    if (config.trackConflicts) {
      this._trackConflict(conflictInfo);
    }

    // Resolve the conflict
    const result = ConflictResolver.resolveConflict(
      conflictInfo,
      config.strategy,
      config.mergeStrategy
    );

    // Update conflict info with resolution result
    if (result.success) {
      conflictInfo.resolvedValue = result.resolvedValue;
      conflictInfo.resolvedAt = Date.now();

      // Store the resolved value locally
      this.storage.set(key, result.resolvedValue as T[Extract<keyof T, string>]);

      // Update metadata to reflect the resolved state
      const resolvedHash = computeHash(result.resolvedValue);
      await this.metadataManager.set(key, {
        syncStatus: SyncStatus.Synced,
        digest: resolvedHash,
        version: Date.now(),
      });

      Log.info(`Ganon: Successfully resolved conflict for key ${key} using strategy: ${config.strategy}`);
    } else {
      Log.error(`Ganon: Failed to resolve conflict for key ${key}: ${result.error}`);
    }

    return result;
  }

  /**
   * Checks for data conflicts during sync operations and resolves them if found.
   * @internal This method is used internally and will be integrated into sync flow
   */
  // @ts-ignore - Method will be used when integrated into sync operations
  private async _checkAndResolveConflicts(
    key: Extract<keyof T, string>,
    localValue: T[Extract<keyof T, string>] | undefined,
    remoteValue: T[Extract<keyof T, string>] | undefined,
    localMetadata: LocalSyncMetadata,
    remoteMetadata: SyncMetadata
  ): Promise<boolean> {
    // Check if there's a data conflict
    const hasConflict = ConflictResolver.detectConflict<T>(
      key,
      localValue,
      remoteValue,
      localMetadata,
      remoteMetadata
    );

    if (!hasConflict) {
      return true; // No conflict, continue normally
    }

    Log.warn(`Ganon: Data conflict detected for key ${key}`);

    // Handle the conflict
    const result = await this._handleDataConflict(
      key,
      localValue,
      remoteValue,
      localMetadata,
      remoteMetadata,
      this._currentConflictConfig
    );

    return result.success;
  }

  /**
   * Forces a metadata cache refresh for the given key when metadata is stale.
   *
   * This method is used during hydration when remote data is fetched and correct,
   * but the metadata cache is out of sync (e.g., remoteMetadata.digest !== computedHash).
   *
   * What it does:
   * - Invalidates metadata caches (regular and hydration)
   * - Fetches remote data to compute correct hash
   * - Gets fresh metadata from remote
   * - Validates that computed hash matches remote metadata digest
   *
   * What it does NOT do:
   * - Does not store remote data locally (data is already fetched by caller)
   * - Does not replace local data (this is metadata-only refresh)
   *
   * This is different from _useRemoteDataDespiteIntegrityFailure which actually
   * replaces local data when there are persistent integrity issues.
   */
  private async _forceMetadataRefresh(key: Extract<keyof T, string>): Promise<{ success: boolean; recoveryStrategy: string }> {
    try {
      Log.info(`Ganon: Attempting force metadata refresh for key ${key}`);

      // Invalidate all caches
      await this.metadataManager.invalidateCache(key);
      await this.metadataManager.invalidateCacheForHydration(key);

      // Force a fresh fetch
      const remoteValue = await this.firestore.fetch(key);
      if (remoteValue !== undefined) {
        const newComputedHash = computeHash(remoteValue);
        const freshMetadata = await this.metadataManager.getRemoteMetadataOnly(key);

        if (freshMetadata && freshMetadata.digest === newComputedHash) {
          Log.info(`Ganon: Force metadata refresh successful for key ${key}`);
          return { success: true, recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH };
        }
      }

      Log.warn(`Ganon: Force metadata refresh failed for key ${key}`);
      return { success: false, recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH };
    } catch (error) {
      Log.error(`Ganon: Error during force metadata refresh for key ${key}: ${error}`);
      return { success: false, recoveryStrategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH };
    }
  }

  /**
   * Uses local data as a fallback when remote integrity check fails.
   * This strategy ensures the user still gets data for the key by using
   * the local version and updating metadata to reflect the local state.
   * If no local data is available, falls back to using remote data despite integrity issues.
   */
  private async _useLocalData(key: Extract<keyof T, string>): Promise<{ success: boolean; recoveryStrategy: string }> {
    try {
      const localValue = this.storage.get(key);

      if (localValue !== undefined) {
        Log.info(`Ganon: Using local data for key ${key} due to integrity failure`);

        const localHash = computeHash(localValue);

        // Update metadata to reflect local state
        await this.metadataManager.set(key, {
          syncStatus: SyncStatus.Synced,
          digest: localHash,
          version: Date.now(),
        });

        Log.info(`Ganon: Successfully used local data for key ${key}`);
        return { success: true, recoveryStrategy: IntegrityFailureRecoveryStrategy.USE_LOCAL };
      } else {
        // No local data available - use remote data despite integrity issue
        Log.warn(`Ganon: No local data available for key ${key}, using remote data despite integrity failure`);
        return await this._useRemoteDataDespiteIntegrityFailure(key);
      }
    } catch (error) {
      Log.error(`Ganon: Error using local data for key ${key}: ${error}`);
      return { success: false, recoveryStrategy: IntegrityFailureRecoveryStrategy.USE_LOCAL };
    }
  }

  /**
   * Uses remote data as the source of truth when integrity failures occur.
   * This strategy replaces local data with remote data and updates metadata accordingly.
   *
   * Use cases:
   * - Remote data is authoritative (server is source of truth)
   * - Local data corruption suspected
   * - Force sync from server (discard local changes)
   * - Conflict resolution favoring remote
   *
   * This method:
   * - Fetches remote data
   * - Computes hash of remote data
   * - Stores remote data locally (replacing any local data)
   * - Updates metadata to reflect remote state
   */
  private async _useRemoteDataDespiteIntegrityFailure(key: Extract<keyof T, string>): Promise<{ success: boolean; recoveryStrategy: string }> {
    try {
      Log.info(`Ganon: Using remote data despite integrity failure for key ${key}`);

      const remoteValue = await this.firestore.fetch(key);
      if (remoteValue !== undefined) {
        const remoteComputedHash = computeHash(remoteValue);

        // Store the remote data locally
        this.storage.set(key, remoteValue as T[Extract<keyof T, string>]);

        // Update metadata to reflect the remote state
        await this.metadataManager.set(key, {
          syncStatus: SyncStatus.Synced,
          digest: remoteComputedHash,
          version: Date.now(),
        });

        Log.info(`✅ Ganon: Successfully used remote data despite integrity failure for key ${key}`);
        return { success: true, recoveryStrategy: 'use_remote_despite_integrity' };
      }

      Log.warn(`Ganon: No remote data available for key ${key}`);
      return { success: false, recoveryStrategy: 'use_remote_despite_integrity' };
    } catch (error) {
      Log.error(`Ganon: Error using remote data despite integrity failure for key ${key}: ${error}`);
      return { success: false, recoveryStrategy: 'use_remote_despite_integrity' };
    }
  }

  /**
   * Notifies about integrity failures to alert users or monitoring systems
   * when data integrity issues are detected during sync operations.
   */
  private _notifyIntegrityFailure(failure: IntegrityFailureInfo): void {
    Log.info(`Ganon: Integrity failure notification for key ${failure.key}`);

    // This could be extended to emit events or call callbacks
    // For now, we just log the information
  }

  /**
   * Notifies about data conflicts to alert users or monitoring systems
   * when conflicts are detected during sync operations.
   */
  private _notifyConflict(conflict: ConflictInfo<T>): void {
    Log.warn(`Ganon: Data conflict notification for key ${conflict.key}`);
    Log.warn(`Ganon: Conflict details - Local: ${JSON.stringify(conflict.localValue)}, Remote: ${JSON.stringify(conflict.remoteValue)}`);
    Log.warn(`Ganon: Resolution strategy: ${conflict.resolutionStrategy}`);

    // This could be extended to emit events or call callbacks
    // For now, we just log the information
  }

  /**
   * Tracks integrity failures for monitoring and analytics purposes.
   * This helps identify patterns and frequency of integrity issues across the system.
   */
  private _trackIntegrityFailure(failure: IntegrityFailureInfo): void {
    Log.verbose(`Ganon: Tracking integrity failure for key ${failure.key}`);

    // This could be extended to send metrics to monitoring systems
    // For now, we just log the information
  }

  /**
   * Tracks data conflicts for monitoring and analytics purposes.
   * This helps identify patterns and frequency of conflicts across the system.
   */
  private _trackConflict(conflict: ConflictInfo<T>): void {
    Log.verbose(`Ganon: Tracking data conflict for key ${conflict.key}`);

    // Add to tracked conflicts
    this._trackedConflicts.push(conflict);

    // Clean up old conflicts if we exceed the limit
    const config = this._conflictResolutionConfig;
    if (config.maxTrackedConflicts && this._trackedConflicts.length > config.maxTrackedConflicts) {
      // Keep only the most recent conflicts
      this._trackedConflicts = this._trackedConflicts
        .sort((a, b) => b.detectedAt - a.detectedAt)
        .slice(0, config.maxTrackedConflicts);
    }

    // This could be extended to send metrics to monitoring systems
    // For now, we just log the information
  }

  /**
   * Gets the list of tracked conflicts for analytics or debugging purposes.
   */
  public getTrackedConflicts(): ConflictInfo<T>[] {
    return [...this._trackedConflicts];
  }

  /**
   * Clears the tracked conflicts list.
   */
  public clearTrackedConflicts(): void {
    this._trackedConflicts = [];
  }
}
