import MetadataStorage from '../../models/sync/MetadataStorage';
import { SyncMetadata } from '../../models/sync/SyncMetadata';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { REMOTE_METADATA_KEY } from '../../constants';
import Log from '../../utils/Log';
import UserManager from '../../managers/UserManager';
import MetadataStore from '../local/MetadataStore';
import RemoteMetadataCache from './RemoteMetadataCache';
import { CancelHandle, Scheduler } from '../../ports/Scheduler';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';

/**
 * Write-side debounced flush queue for remote metadata map updates.
 */
export default class MetadataFlushQueue<T extends BaseStorageMapping> {
  private readonly MAX_PENDING_KEYS = 1000;
  private pendingKeys = new Set<string>();
  private flushHandle: CancelHandle | null = null;
  private docRef: FirebaseFirestoreTypes.DocumentReference | null = null;

  constructor(
    private referenceManager: FirestoreReferenceManager<T>,
    private adapter: FirestoreAdapter<T>,
    private userManager: UserManager<T>,
    private documentKey: string,
    private metadataStore: MetadataStore<T>,
    private remoteCache: RemoteMetadataCache<T>,
    private scheduler: Scheduler,
    private debounceMs: number,
    readonly conflictStrategy: ConflictResolutionStrategy,
    private writeLegacyMetadata: boolean = false
  ) {}

  enqueue(key: string): void {
    this.pendingKeys.add(key);
    if (this.pendingKeys.size > this.MAX_PENDING_KEYS) {
      void this.flush().catch(error => Log.error(`Ganon: Overflow flush failed: ${error}`));
      return;
    }
    this._scheduleFlush();
  }

  async flush(): Promise<void> {
    if (!this.userManager.isUserLoggedIn() || this.pendingKeys.size === 0) {
      return;
    }

    await this.remoteCache.fetch();
    const updates: MetadataStorage = {};
    const cached = this.remoteCache.getCached();

    for (const key of this.pendingKeys) {
      const localMeta = this.metadataStore.get(key as Extract<keyof T, string>);
      const remoteMeta = cached[key];
      if (remoteMeta && this.remoteCache.hasConflict(localMeta, remoteMeta)) {
        updates[key] = this._resolveConflict(localMeta, remoteMeta);
      } else {
        updates[key] = { d: localMeta.digest, v: localMeta.version };
      }
    }

    if (this.writeLegacyMetadata) {
      await this._batchUpdateRemote(updates);
    }
    this.remoteCache.mergeIntoCache(updates);
    this.pendingKeys.clear();
  }

  cancelAll(): void {
    if (this.flushHandle) {
      this.flushHandle.cancel();
      this.flushHandle = null;
    }
    this.pendingKeys.clear();
  }

  destroy(): void {
    this.cancelAll();
  }

  hasPending(key: string): boolean {
    return this.pendingKeys.has(key);
  }

  private _scheduleFlush(): void {
    if (this.flushHandle) {
      this.flushHandle.cancel();
    }
    this.flushHandle = this.scheduler.schedule(() => {
      if (!this.userManager.isUserLoggedIn()) return;
      this.flush().catch(error => Log.error(`Ganon: Scheduled flush failed: ${error}`));
    }, this.debounceMs);
  }

  private _getDocRef(): FirebaseFirestoreTypes.DocumentReference {
    if (!this.docRef) {
      const backupRef = this.referenceManager.getBackupRef();
      this.docRef = this.referenceManager.getDocumentRef(backupRef, this.documentKey);
    }
    return this.docRef;
  }

  private async _batchUpdateRemote(updates: MetadataStorage): Promise<void> {
    const mergedMetadata = { ...this.remoteCache.getCached(), ...updates };
    await this.adapter.setDocument(
      this._getDocRef(),
      { [REMOTE_METADATA_KEY]: mergedMetadata },
      { merge: true }
    );
  }

  private _resolveConflict(local: SyncMetadata, remote: { d: string; v: number }): { d: string; v: number } {
    switch (this.conflictStrategy) {
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
}
