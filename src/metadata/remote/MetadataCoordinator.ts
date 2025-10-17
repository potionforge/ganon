import { SyncMetadata } from "../../models/sync/SyncMetadata";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import Log from "../../utils/Log";
import MetadataStorage from "../../models/sync/MetadataStorage";
import FirestoreReferenceManager from "../../firestore/ref/FirestoreReferenceManager";
import FirestoreAdapter from "../../firestore/FirestoreAdapter";
import { SyncErrorType } from "../../errors/SyncError";
import SyncError from "../../errors/SyncError";
import { FirebaseFirestoreTypes } from "@react-native-firebase/firestore";
import { REMOTE_METADATA_KEY } from "../../constants";
import LocalMetadataManager from "../local/LocalMetadataManager";
import LocalSyncMetadata from "../../models/sync/LocalSyncMetadata";
import { SyncStatus } from "../../models/sync/SyncStatus";
import UserManager from "../../managers/UserManager";

interface RemoteMetadataCache {
  data: MetadataStorage;
  lastFetchTime: number;
  isDirty: boolean;
  pendingKeys: Set<string>; // Keys with pending local changes
}

interface CacheConfig {
  maxAge: number; // Cache expiry time in ms (e.g., 5 minutes)
  batchSize: number; // Max keys to batch in single request
  retryAttempts: number;
  conflictResolutionStrategy: ConflictResolutionStrategy;
}

export default class MetadataCoordinator<T extends BaseStorageMapping> {
  private readonly MAX_PENDING_KEYS = 1000; // Prevent memory leaks

  private cache: RemoteMetadataCache = {
    data: {},
    lastFetchTime: 0,
    isDirty: false,
    pendingKeys: new Set()
  };

  private config: CacheConfig = {
    maxAge: 5 * 60 * 1000, // 5 minutes
    batchSize: 50,
    retryAttempts: 3,
    conflictResolutionStrategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS
  };

  private fetchPromise: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | number | null = null;
  private docRef: FirebaseFirestoreTypes.DocumentReference | null = null;

  constructor(
    private referenceManager: FirestoreReferenceManager<T>,
    private adapter: FirestoreAdapter<T>,
    private localMetadata: LocalMetadataManager<T>,
    private userManager: UserManager<T>,
    private documentKey: string
  ) {
    Log.verbose('Ganon: RemoteMetadataCacheManager.constructor');
    // Don't initialize docRef here - lazy load it when needed
  }

  private _getDocRef(): FirebaseFirestoreTypes.DocumentReference {
    if (!this.docRef) {
      const backupRef = this.referenceManager.getBackupRef();
      this.docRef = this.referenceManager.getDocumentRef(backupRef, this.documentKey);
    }
    return this.docRef;
  }

  private _isCacheValid(): boolean {
    return this.cache.lastFetchTime > 0 && !this._shouldInvalidateCache();
  }

  async needsHydration(key: Extract<keyof T, string>): Promise<boolean> {
    if (!this._isCacheValid()) {
      await this.getRemoteMetadata();
    }
    const remoteMetadata = this.cache.data;
    const localMetadata = this.localMetadata.get(key);
    return remoteMetadata[key]?.v > localMetadata.version;
  }

  /**
   * Get remote metadata with intelligent caching
   */
  async getRemoteMetadata(keys?: string[]): Promise<MetadataStorage> {
    Log.verbose(`Ganon: RemoteMetadataCacheManager.getRemoteMetadata, keys: ${keys?.join(',')}`);
    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot get remote metadata: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Return cached data if still valid and no specific keys requested
    if (!this._shouldInvalidateCache() && !keys) {
      Log.verbose('Ganon: Using cached remote metadata');
      return this.cache.data;
    }

    // Prevent multiple concurrent fetches
    if (this.fetchPromise) {
      await this.fetchPromise;
      return this.cache.data;
    }

    this.fetchPromise = this._fetchRemoteMetadata(keys);
    await this.fetchPromise;
    this.fetchPromise = null;

    return this.cache.data;
  }

  /**
   * Update local cache and mark for sync
   */
  async updateLocalMetadata<K extends keyof T>(key: K, metadata: LocalSyncMetadata, scheduleRemoteSync: boolean = true): Promise<void> {
    Log.verbose(`Ganon: RemoteMetadataCacheManager.updateLocalMetadata, key: ${String(key)}, scheduleRemoteSync: ${scheduleRemoteSync}`);

    // Update local metadata manager
    this.localMetadata.set(key, metadata);

    // Only mark for remote sync if requested
    if (scheduleRemoteSync) {
      // Mark key as having pending changes
      this.cache.pendingKeys.add(String(key));
      this.cache.isDirty = true;

      // Check if we have too many pending keys
      if (this.cache.pendingKeys.size > this.MAX_PENDING_KEYS) {
        Log.info('Ganon: Too many pending keys, forcing immediate sync');
        await this.syncToRemote();
      } else {
        // Schedule flush to remote
        this._scheduleFlush();
      }
    }
  }

  /**
   * Update the sync status of a key
   * @param key - The key to update the sync status for
   * @param status - The new sync status
   */
  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): void {
    this.localMetadata.updateSyncStatus(key, status);
  }

  /**
   * Sync local changes to remote with conflict resolution
   */
  async syncToRemote(): Promise<void> {
    Log.verbose('Ganon: RemoteMetadataCacheManager.syncToRemote');

    // Check if user is still logged in before proceeding
    if (!this.userManager.isUserLoggedIn()) {
      Log.verbose('Ganon: Sync cancelled - user not logged in');
      return;
    }

    if (this.cache.pendingKeys.size === 0) {
      Log.verbose('Ganon: No pending changes to sync');
      return;
    }

    try {
      // Ensure cache is valid before proceeding
      if (!this._isCacheValid()) {
        await this.getRemoteMetadata();
      }

      // Resolve conflicts for pending keys
      const updates: MetadataStorage = {};
      const conflicts: string[] = [];

      for (const key of this.cache.pendingKeys) {
        const localMeta = this.localMetadata.get(key as keyof T);
        const remoteMeta = this.cache.data[key];

        if (remoteMeta && this._hasConflict(localMeta, remoteMeta)) {
          conflicts.push(key);
          updates[key] = this._resolveConflict(localMeta, remoteMeta);
        } else {
          updates[key] = {
            d: localMeta.digest,
            v: localMeta.version
          };
        }
      }

      if (conflicts.length > 0) {
        Log.info(`Ganon: Resolved ${conflicts.length} conflicts: ${conflicts.join(',')}`);
      }

      // Batch update to Firestore
      await this._batchUpdateRemote(updates);

      // Update cache and clear pending
      Object.assign(this.cache.data, updates);
      this.cache.pendingKeys.clear();
      this.cache.isDirty = false;
      this.cache.lastFetchTime = Date.now();

    } catch (error) {
      Log.error(`Ganon: Failed to sync to remote: ${error}`);
      throw error;
    }
  }

  /**
   * Force cache refresh from remote
   */
  async invalidateCache(): Promise<void> {
    Log.verbose('Ganon: RemoteMetadataCacheManager.invalidateCache');
    this.cache.lastFetchTime = 0;
    await this.getRemoteMetadata();
  }

  /**
   * Check if we need to sync before a read operation
   */
  async ensureConsistency(key: string): Promise<SyncMetadata> {
    Log.verbose(`Ganon: RemoteMetadataCacheManager.ensureConsistency, key: ${key}`);

    // If key has pending changes, sync first
    if (this.cache.pendingKeys.has(key)) {
      await this.syncToRemote();
    }

    // Ensure cache is valid before proceeding
    if (!this._isCacheValid()) {
      await this.getRemoteMetadata();
    }

    // Get latest remote state
    const remoteData = this.cache.data;
    const remoteMeta = remoteData[key];

    if (remoteMeta) {
      // Compare with local and update if different
      const localMeta = this.localMetadata.get(key as keyof T);
      if (this._hasConflict(localMeta, remoteMeta)) {
        const resolved = this._resolveConflict(localMeta, remoteMeta);
        this.localMetadata.set(key as keyof T, {
          syncStatus: SyncStatus.Synced,
          digest: resolved.d,
          version: resolved.v,
        });
      }
    }

    return this.localMetadata.get(key as keyof T);
  }

  /**
   * Cache invalidation conditions - when to fetch fresh data
   */
  private _shouldInvalidateCache(): boolean {
    if (!this.cache.lastFetchTime) return true;

    const isExpired = (Date.now() - this.cache.lastFetchTime) > this.config.maxAge;
    return isExpired;
  }

  private async _fetchRemoteMetadata(specificKeys?: string[]): Promise<void> {
    Log.verbose('Ganon: Fetching remote metadata from Firestore');
    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot get remote metadata: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Set fetchPromise before starting the fetch
    this.fetchPromise = this._doFetchRemoteMetadata(specificKeys);
    try {
      await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  private async _doFetchRemoteMetadata(specificKeys?: string[]): Promise<void> {
    try {
      const doc = await this.adapter.getDocument(this._getDocRef());

      if (doc.exists) {
        const remoteMetadata = doc.data()?.[REMOTE_METADATA_KEY] || {};

        if (specificKeys) {
          // Only update cache for specific keys
          for (const key of specificKeys) {
            if (remoteMetadata[key]) {
              this.cache.data[key] = remoteMetadata[key];
            }
          }
        } else {
          // Full cache refresh
          this.cache.data = remoteMetadata;
        }

        this.cache.lastFetchTime = Date.now();
      }
    } catch (error) {
      Log.error(`Ganon: Failed to fetch remote metadata: ${error}`);
      throw error;
    }
  }

  private async _batchUpdateRemote(updates: MetadataStorage): Promise<void> {
    Log.verbose(`Ganon: Batch updating ${Object.keys(updates).length} metadata entries`);

    // Get current remote metadata to merge with updates
    const currentData = this.cache.data;
    const mergedMetadata = { ...currentData, ...updates };

    // Update the entire nested object to avoid dot notation field creation
    const updateData = {
      [REMOTE_METADATA_KEY]: mergedMetadata
    };

    await this.adapter.setDocument(this._getDocRef(), updateData, { merge: true });
  }

  private _hasConflict(local: SyncMetadata, remote: { d: string; v: number }): boolean {
    // If remote version is older or equal to local, it's not a conflict
    if (remote.v <= local.version) {
      return false;
    }

    // If remote version is newer, it's a conflict only if:
    // 1. The digests are different (actual content change)
    // 2. We're not in the middle of a remote fetch (which would update our cache)
    return remote.d !== local.digest && !this.fetchPromise;
  }

  private _resolveConflict(local: SyncMetadata, remote: { d: string; v: number }): { d: string; v: number } {
    Log.verbose('Ganon: Resolving metadata conflict');

    switch (this.config.conflictResolutionStrategy) {
      case ConflictResolutionStrategy.LOCAL_WINS:
        return { d: local.digest, v: local.version };

      case ConflictResolutionStrategy.REMOTE_WINS:
        return { d: remote.d, v: remote.v };

      case ConflictResolutionStrategy.LAST_MODIFIED_WINS:
      default:
        return local.version > remote.v
          ? { d: local.digest, v: local.version }
          : { d: remote.d, v: remote.v };
    }
  }

  private _scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    // Debounce flushes to avoid too many rapid syncs
    this.flushTimer = setTimeout(() => {
      // Check if user is still logged in before attempting sync
      if (!this.userManager.isUserLoggedIn()) {
        Log.verbose('Ganon: Scheduled flush cancelled - user no longer logged in');
        return;
      }

      this.syncToRemote().catch(error => {
        Log.error(`Ganon: Scheduled flush failed: ${error}`);
      });
    }, 1000); // 1 second debounce
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
  }

  /**
   * Cancel any pending flushes and clear cache for logout
   */
  cancelPendingOperations(): void {
    Log.verbose('Ganon: RemoteMetadataCacheManager.cancelPendingOperations');
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Clear pending keys to prevent future sync attempts
    this.cache.pendingKeys.clear();
    this.cache.isDirty = false;

    // Reset cache
    this.cache.data = {};
    this.cache.lastFetchTime = 0;
  }
}
