import FirestoreManager from "../../firestore/FirestoreManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import BaseSyncOperation from "./BaseSyncOperation";
import StorageManager from "../../managers/StorageManager";
import SyncOperationResult from "../../models/sync/SyncOperationResult";
import computeHash from "../../utils/computeHash";
import { SyncStatus } from "../../models/sync/SyncStatus";
import Log from "../../utils/Log";
import { nextVersion } from "../../utils/nextVersion";
import MetadataManager from "../../metadata/MetadataManager";
import ISyncOperation from "../../models/interfaces/ISyncOperation";
import SessionToken from "../SessionToken";

export default class SetOperation<T extends BaseStorageMapping> extends BaseSyncOperation<T> implements ISyncOperation<T> {
  constructor(
    key: Extract<keyof T, string>,
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
    session: SessionToken,
  ) {
    Log.verbose(`Ganon: SetOperation.constructor, key: ${String(key)}`);
    super(key, storage, firestore, metadataManager, session);
  }

  async execute(): Promise<SyncOperationResult<T>> {
    const startTime = Date.now();
    Log.info(`SetOperation: Starting execution for key "${this.key}"`);

    try {
      if (this.session.isStale()) {
        Log.info(`Ganon: aborted stale sync work (SetOperation.start key=${String(this.key)})`);
        return { success: true, key: this.key, aborted: true };
      }

      // Set status to InProgress when operation starts
      this.metadataManager.updateSyncStatus(this.key, SyncStatus.InProgress);

      const newValue = this.storage.get(this.key);
      const digest = computeHash(newValue);
      const existing = this.metadataManager.get(this.key);
      const version = nextVersion(existing?.version ?? 0);

      await this.firestore.syncValueWithDigest(this.key, newValue, digest, version, this.session);

      if (this.session.isStale()) {
        Log.info(`Ganon: aborted stale sync work (SetOperation.post-remote key=${String(this.key)})`);
        return { success: true, key: this.key, aborted: true };
      }

      const metadata = {
        syncStatus: SyncStatus.Synced,
        digest,
        version,
      };
      await this.metadataManager.recordLocalChange(this.key, metadata);

      const duration = Date.now() - startTime;
      Log.info(`✅ Ganon: Completed sync for key "${this.key}" in ${duration}ms`);

      return {
        success: true,
        key: this.key,
      };

    } catch (error) {
      // Set status to Failed when operation fails
      this.metadataManager.updateSyncStatus(this.key, SyncStatus.Failed);
      const duration = Date.now() - startTime;
      Log.error(`SetOperation: Failed execution for key "${this.key}" after ${duration}ms: ${error}`);
      return this.handleError(error);
    }
  }

  serialize(): object {
    return {
      type: 'set',
      key: this.key,
      userId: this.session.userId ?? undefined,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
    };
  }

  static deserialize<T extends BaseStorageMapping>(data: any, deps: {
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
    session: SessionToken,
  }): SetOperation<T> {
    const op = new SetOperation<T>(
      data.key,
      deps.storage,
      deps.firestore,
      deps.metadataManager,
      deps.session
    );
    op.retryCount = data.retryCount || 0;
    op.maxRetries = data.maxRetries || 3;
    return op;
  }
}
