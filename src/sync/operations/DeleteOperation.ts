import FirestoreManager from "../../firestore/FirestoreManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import BaseSyncOperation from "./BaseSyncOperation";
import StorageManager from "../../managers/StorageManager";
import SyncOperationResult from "../../models/sync/SyncOperationResult";
import { SyncStatus } from "../../models/sync/SyncStatus";
import Log from "../../utils/Log";
import MetadataManager from "../../metadata/MetadataManager";

export default class DeleteOperation<T extends BaseStorageMapping> extends BaseSyncOperation<T> {
  constructor(
    key: Extract<keyof T, string>,
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
  ) {
    Log.verbose(`Ganon: DeleteOperation.constructor, key: ${String(key)}`);
    super(key, storage, firestore, metadataManager);
  }

  async execute(): Promise<SyncOperationResult<T>> {
    Log.verbose(`Ganon: DeleteOperation.execute, key: ${String(this.key)}`);
    try {
      // Set status to InProgress when operation starts
      this.metadataManager.updateSyncStatus(this.key, SyncStatus.InProgress);

      // Step 1: Delete from Firestore
      await this.firestore.delete(this.key);

      // Step 2: Remove from local storage and metadata
      this.storage.remove(this.key);
      await this.metadataManager.set(this.key, {
        syncStatus: SyncStatus.Synced,
        version: Date.now(),
        digest: '',
      });

      return {
        success: true,
        key: this.key,
      };
    } catch (error) {
      // Set status to Failed when operation fails
      this.metadataManager.updateSyncStatus(this.key, SyncStatus.Failed);

      // Standard error handling for any failures
      return this.handleError(error);
    }
  }

  serialize(): object {
    return {
      type: 'delete',
      key: this.key,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
    };
  }

  static deserialize<T extends BaseStorageMapping>(data: any, deps: {
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
  }): DeleteOperation<T> {
    const op = new DeleteOperation<T>(
      data.key,
      deps.storage,
      deps.firestore,
      deps.metadataManager
    );
    op.retryCount = data.retryCount || 0;
    op.maxRetries = data.maxRetries || 3;
    return op;
  }
}
