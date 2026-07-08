import { GanonConfig } from "../models/config/GanonConfig";
import { CloudBackupConfig } from "../models/config/CloudBackupConfig";
import MetadataStore from "./local/MetadataStore";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import LocalSyncMetadata from "../models/sync/LocalSyncMetadata";
import { SyncMetadata } from "../models/sync/SyncMetadata";
import { SyncStatus } from "../models/sync/SyncStatus";
import MetadataCoordinatorRepo from "./MetadataCoordinatorRepo";
import MetadataCoordinator from "./remote/MetadataCoordinator";
import Log from "../utils/Log";
import KeyRouter from "../routing/KeyRouter";

export default class MetadataManager<T extends BaseStorageMapping> {
  constructor(
    private config: GanonConfig<T>,
    private coordinatorRepo: MetadataCoordinatorRepo<T>,
    private metadataStore: MetadataStore<T>,
    keyRouter?: KeyRouter<T>
  ) {
    this.keyRouter = keyRouter ?? new KeyRouter(config.cloudConfig ?? ({} as CloudBackupConfig<T>));
  }

  private keyRouter: KeyRouter<T>;
  private lastRemoteSnapshot: Record<string, { d: string; v: number }> = {};

  get(key: Extract<keyof T, string>): LocalSyncMetadata | undefined {
    return this.metadataStore.get(key);
  }

  isNeverSynced(key: Extract<keyof T, string>): boolean {
    return this.metadataStore.isNeverSynced(key);
  }

  async recordLocalChange(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void> {
    const coordinator = this._getCoordinator(key);
    if (!coordinator) return;
    await coordinator.recordLocalChange(key, metadata);
  }

  async persistLocalChange(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void> {
    this.metadataStore.recordLocalChange(key, metadata);
  }

  async recordSyncedState(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void> {
    const coordinator = this._getCoordinator(key);
    if (!coordinator) return;
    await coordinator.recordSyncedState(key, metadata);
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
    if (!this.config?.cloudConfig) return;

    const coordinators = Object.keys(this.config.cloudConfig)
      .map(documentName => this.coordinatorRepo.getCoordinator(documentName as Extract<keyof T, string>))
      .filter(Boolean);

    // One fetch per document: lazy invalidate then refresh
    coordinators.forEach(coordinator => coordinator.invalidateCache());
    await Promise.all(coordinators.map(coordinator => coordinator.refreshCache()));
    this.lastRemoteSnapshot = {};
    for (const coordinator of coordinators) {
      Object.assign(this.lastRemoteSnapshot, coordinator.getCachedRemote());
    }
  }

  /** Remote metadata from the most recent hydrateMetadata() pass — no additional fetch. */
  getRemoteMetaForKey(key: Extract<keyof T, string>): { d: string; v: number } | undefined {
    return this.lastRemoteSnapshot[String(key)];
  }

  async set(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void> {
    await this.recordLocalChange(key, metadata);
  }

  async needsHydration(key: Extract<keyof T, string>): Promise<boolean> {
    Log.verbose(`Ganon: MetadataManager.needsHydration, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) return false;
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
  async invalidateCacheForHydration(_key: Extract<keyof T, string>): Promise<void> {
    // Hydration pass refreshes per-document cache in hydrateMetadata(); no per-key fetch.
  }

  async invalidateCache(key: Extract<keyof T, string>): Promise<void> {
    Log.verbose(`Ganon: MetadataManager.invalidateCache, key: ${String(key)}`);
    const coordinator = this._getCoordinator(key);
    if (!coordinator) return;
    coordinator.invalidateCache();
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

  private _router(key: Extract<keyof T, string>): string | undefined {
    return this.keyRouter.route(key)?.document;
  }
}
