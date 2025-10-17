import { GanonConfig } from "../models/config/GanonConfig";
import LocalMetadataManager from "./local/LocalMetadataManager";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import LocalSyncMetadata from "../models/sync/LocalSyncMetadata";
import { SyncMetadata } from "../models/sync/SyncMetadata";
import { SyncStatus } from "../models/sync/SyncStatus";
import MetadataCoordinatorRepo from "./MetadataCoordinatorRepo";
import MetadataCoordinator from "./remote/MetadataCoordinator";
import Log from "../utils/Log";

export default class MetadataManager<T extends BaseStorageMapping> {
  private keyToDocumentMap: Map<string, string> = new Map();

  constructor(
    private config: GanonConfig<T>,
    private coordinatorRepo: MetadataCoordinatorRepo<T>,
    private localMetadata: LocalMetadataManager<T>
  ) {
    this._buildKeyToDocumentMap();
  }

  get(key: Extract<keyof T, string>): LocalSyncMetadata | undefined {
    return this.localMetadata.get(key);
  }

  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): void {
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot update sync status for key ${key}: no coordinator found`);
      return;
    }
    coordinator.updateSyncStatus(key, status);
  }

  async hydrateMetadata(): Promise<void> {
    Log.info('Ganon: MetadataManager.hydrateMetadata');
    if (!this.config?.cloudConfig) {
      return;
    }
    const coordinators = Object.keys(this.config.cloudConfig)
      .map(documentName => this.coordinatorRepo.getCoordinator(documentName as Extract<keyof T, string>))
      .filter(Boolean);

    // Run in parallel
    await Promise.all(coordinators.map(coordinator => coordinator.invalidateCache()));
  }

  async set(key: Extract<keyof T, string>, metadata: LocalSyncMetadata, scheduleRemoteSync: boolean = true): Promise<void> {
    Log.verbose(`Ganon: MetadataManager.set, key: ${String(key)}, metadata: ${JSON.stringify(metadata)}, scheduleRemoteSync: ${scheduleRemoteSync}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot set metadata for key ${key}: no coordinator found`);
      return;
    }
    await coordinator.updateLocalMetadata(key, metadata, scheduleRemoteSync);
  }

  async needsHydration(key: Extract<keyof T, string>): Promise<boolean> {
    Log.verbose(`Ganon: MetadataManager.needsHydration, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot check hydration for key ${key}: no coordinator found`);
      return false;
    }

    // Force cache invalidation for hydration to ensure fresh remote metadata
    await this.invalidateCacheForHydration(key);

    return coordinator.needsHydration(key);
  }

  async ensureConsistency(key: Extract<keyof T, string>): Promise<SyncMetadata | undefined> {
    Log.verbose(`Ganon: MetadataManager.ensureConsistency, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot ensure consistency for key ${key}: no coordinator found`);
      return undefined;
    }
    return coordinator.ensureConsistency(key);
  }

  /**
   * Gets remote metadata without syncing local changes to remote.
   * This is used during hydration to avoid pushing local metadata to remote.
   */
  async getRemoteMetadataOnly(key: Extract<keyof T, string>): Promise<SyncMetadata | undefined> {
    Log.verbose(`Ganon: MetadataManager.getRemoteMetadataOnly, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot get remote metadata for key ${key}: no coordinator found`);
      return undefined;
    }

    // Get remote metadata without syncing local changes
    const remoteMetadata = await coordinator.getRemoteMetadata([key]);
    const remoteMeta = remoteMetadata[key];

    if (remoteMeta) {
      return {
        digest: remoteMeta.d,
        version: remoteMeta.v
      };
    }

    return undefined;
  }

  /**
   * Force cache invalidation for hydration operations to ensure fresh remote metadata.
   * This ensures we're comparing against the most current remote data.
   */
  async invalidateCacheForHydration(key: Extract<keyof T, string>): Promise<void> {
    Log.verbose(`Ganon: MetadataManager.invalidateCacheForHydration, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot invalidate cache for key ${key}: no coordinator found`);
      return;
    }

    try {
      await coordinator.invalidateCache();
    } catch (error) {
      Log.error(`Failed to invalidate cache for hydration for key ${key}: ${error}`);
      // Don't re-throw the error to maintain graceful degradation
    }
  }

  async invalidateCache(key: Extract<keyof T, string>): Promise<void> {
    Log.verbose(`Ganon: MetadataManager.invalidateCache, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) {
      Log.warn(`Cannot invalidate cache for key ${key}: no coordinator found`);
      return;
    }
    await coordinator.invalidateCache();
  }

  /**
   * Cancel all pending sync operations for user logout
   */
  cancelPendingOperations(): void {
    Log.verbose('Ganon: MetadataManager.cancelPendingOperations');
    if (!this.config?.cloudConfig) {
      return;
    }

    // Cancel operations on all coordinators
    Object.keys(this.config.cloudConfig).forEach(documentName => {
      const coordinator = this.coordinatorRepo.getCoordinator(documentName as Extract<keyof T, string>);
      if (coordinator) {
        coordinator.cancelPendingOperations();
      }
    });
  }

  /* P R I V A T E */

  private _getCoordinator(key: Extract<keyof T, string>): MetadataCoordinator<T> | undefined {
    try {
      const documentName = this._router(key);
      if (!documentName) {
        Log.warn(`Document not found for key: ${key}`);
        return undefined;
      }

      const coordinator = this.coordinatorRepo.getCoordinator(documentName as Extract<keyof T, string>);
      if (!coordinator) {
        Log.warn(`Coordinator not found for document: ${documentName}`);
        return undefined;
      }

      return coordinator;
    } catch (error) {
      Log.error(`Error getting coordinator for key ${key}: ${error}`);
      return undefined;
    }
  }

  private _buildKeyToDocumentMap(): void {
    if (!this.config?.cloudConfig) {
      Log.warn('Ganon: MetadataManager._buildKeyToDocumentMap, no cloudConfig found');
      return;
    }

    // Clear the map before rebuilding
    this.keyToDocumentMap.clear();

    // Process each document in the cloudConfig
    Object.entries(this.config.cloudConfig).forEach(([documentName, config]) => {

      // Process docKeys if they exist
      if (config.docKeys && Array.isArray(config.docKeys)) {
        config.docKeys.forEach(key => {
          if (typeof key === 'string' && key) {
            this.keyToDocumentMap.set(key, documentName);
          } else {
            Log.warn(`Ganon: MetadataManager._buildKeyToDocumentMap, invalid docKey in ${documentName}: ${key}`);
          }
        });
      }

      // Process subcollectionKeys if they exist
      if (config.subcollectionKeys && Array.isArray(config.subcollectionKeys)) {
        config.subcollectionKeys.forEach(key => {
          if (typeof key === 'string' && key) {
            this.keyToDocumentMap.set(key, documentName);
          } else {
            Log.warn(`Ganon: MetadataManager._buildKeyToDocumentMap, invalid subcollectionKey in ${documentName}: ${key}`);
          }
        });
      }
    });
  }

  private _router(key: Extract<keyof T, string>): string | undefined {
    return this.keyToDocumentMap.get(key);
  }
}
