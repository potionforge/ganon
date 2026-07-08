import { SyncMetadata } from "../../models/sync/SyncMetadata";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import Log from "../../utils/Log";
import MetadataStorage from "../../models/sync/MetadataStorage";
import FirestoreReferenceManager from "../../firestore/ref/FirestoreReferenceManager";
import FirestoreAdapter from "../../firestore/FirestoreAdapter";
import LocalSyncMetadata from "../../models/sync/LocalSyncMetadata";
import { SyncStatus } from "../../models/sync/SyncStatus";
import UserManager from "../../managers/UserManager";
import { Scheduler, SystemScheduler } from "../../ports/Scheduler";
import { ResolvedGanonConfig } from "../../models/config/resolveGanonConfig";
import MetadataStore from "../local/MetadataStore";
import RemoteMetadataCache from "./RemoteMetadataCache";
import MetadataFlushQueue from "./MetadataFlushQueue";

/** Per-document metadata coordinator composing cache + flush queue + local store. */
export default class MetadataCoordinator<T extends BaseStorageMapping> {
  private remoteCache: RemoteMetadataCache<T>;
  private flushQueue: MetadataFlushQueue<T>;

  constructor(
    referenceManager: FirestoreReferenceManager<T>,
    adapter: FirestoreAdapter<T>,
    private metadataStore: MetadataStore<T>,
    userManager: UserManager<T>,
    documentKey: string,
    resolvedConfig: ResolvedGanonConfig<T>,
    scheduler: Scheduler = new SystemScheduler()
  ) {
    this.remoteCache = new RemoteMetadataCache<T>(
      referenceManager,
      adapter,
      userManager,
      documentKey,
      resolvedConfig.metadataCacheMaxAgeMs,
      resolvedConfig.digestReadMode
    );
    this.flushQueue = new MetadataFlushQueue<T>(
      referenceManager,
      adapter,
      userManager,
      documentKey,
      metadataStore,
      this.remoteCache,
      scheduler,
      resolvedConfig.metadataFlushDebounceMs,
      resolvedConfig.conflictResolutionConfig.strategy,
      resolvedConfig.legacyMetadataWrites
    );
  }

  async needsHydration(key: Extract<keyof T, string>): Promise<boolean> {
    await this.remoteCache.fetch();
    const remoteMetadata = this.remoteCache.getCached();
    const localMetadata = this.metadataStore.get(key);
    return (remoteMetadata[key]?.v ?? 0) > localMetadata.version;
  }

  async getRemoteMetadata(keys?: string[]): Promise<MetadataStorage> {
    return this.remoteCache.fetch(keys);
  }

  async recordLocalChange<K extends keyof T>(key: K, metadata: LocalSyncMetadata): Promise<void> {
    this.metadataStore.recordLocalChange(key, metadata);
    this.flushQueue.enqueue(String(key));
  }

  async recordSyncedState<K extends keyof T>(key: K, metadata: LocalSyncMetadata): Promise<void> {
    this.metadataStore.recordSyncedState(key, metadata);
  }

  /** @deprecated use recordLocalChange / recordSyncedState */
  async updateLocalMetadata<K extends keyof T>(
    key: K,
    metadata: LocalSyncMetadata,
    scheduleRemoteSync: boolean = true
  ): Promise<void> {
    if (scheduleRemoteSync) {
      await this.recordLocalChange(key, metadata);
    } else {
      await this.recordSyncedState(key, metadata);
    }
  }

  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): void {
    this.metadataStore.updateSyncStatus(key, status);
  }

  async syncToRemote(): Promise<void> {
    await this.flushQueue.flush();
  }

  invalidateCache(): void {
    this.remoteCache.invalidate();
  }

  async refreshCache(): Promise<void> {
    await this.remoteCache.fetch();
  }

  async ensureConsistency(key: string): Promise<SyncMetadata> {
    if (this.flushQueue.hasPending(key)) {
      await this.flushQueue.flush();
    }
    await this.remoteCache.fetch();
    const remoteMeta = this.remoteCache.getCached()[key];
    if (remoteMeta) {
      const localMeta = this.metadataStore.get(key as Extract<keyof T, string>);
      if (this.remoteCache.hasConflict(localMeta, remoteMeta)) {
        const resolved =
          localMeta.version > remoteMeta.v
            ? { d: localMeta.digest, v: localMeta.version }
            : { d: remoteMeta.d, v: remoteMeta.v };
        this.metadataStore.recordSyncedState(key as Extract<keyof T, string>, {
          syncStatus: SyncStatus.Synced,
          digest: resolved.d,
          version: resolved.v,
        });
      }
    }
    return this.metadataStore.get(key as Extract<keyof T, string>);
  }

  destroy(): void {
    this.flushQueue.destroy();
  }

  cancelPendingOperations(): void {
    this.flushQueue.cancelAll();
    this.remoteCache.invalidate();
  }

  getCachedRemote(): MetadataStorage {
    return this.remoteCache.getCached();
  }

  /** Test-only: expose conflict strategy source for characterization tests. */
  get conflictStrategy() {
    return this.flushQueue.conflictStrategy;
  }
}
