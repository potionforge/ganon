import FirestoreManager from "../../firestore/FirestoreManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import BaseSyncOperation from "./BaseSyncOperation";
import StorageManager from "../../managers/StorageManager";
import SyncOperationResult from "../../models/sync/SyncOperationResult";
import computeHash from "../../utils/computeHash";
import { SyncStatus } from "../../models/sync/SyncStatus";
import Log from "../../utils/Log";
import MetadataManager from "../../metadata/MetadataManager";
import ISyncOperation from "../../models/interfaces/ISyncOperation";

export default class SetOperation<T extends BaseStorageMapping> extends BaseSyncOperation<T> implements ISyncOperation<T> {
  constructor(
    key: Extract<keyof T, string>,
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
  ) {
    Log.verbose(`Ganon: SetOperation.constructor, key: ${String(key)}`);
    super(key, storage, firestore, metadataManager);
  }

  async execute(): Promise<SyncOperationResult<T>> {
    const startTime = Date.now();
    Log.info(`SetOperation: Starting execution for key "${this.key}"`);

    try {
      // Set status to InProgress when operation starts
      this.metadataManager.updateSyncStatus(this.key, SyncStatus.InProgress);
      // Run backup in a transaction to ensure atomicity
      await this.firestore.runTransaction(async (transaction) => {
        // 1. Get new value from storage
        const newValue = this.storage.get(this.key);
        Log.info(`SetOperation: Got new value for key "${this.key}"`);

        // 2. Backup the new value to Firestore
        await this.firestore.backup(this.key, newValue, { transaction });
        Log.info(`SetOperation: Backed up new value for key "${this.key}"`);

        // 3. Compute hash based on the value we're backing up
        const digest = computeHash(newValue);
        Log.info(`SetOperation: Computed digest for key "${this.key}"`);

        // 4. Update metadata with the computed digest
        // Note: The metadata update happens outside the transaction since the coordinator
        // handles its own sync scheduling. The transaction ensures the backup is atomic.
        const metadata = {
          syncStatus: SyncStatus.Synced,
          digest,
          version: Date.now(),
        };
        await this.metadataManager.set(this.key, metadata);
      });

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
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
    };
  }

  static deserialize<T extends BaseStorageMapping>(data: any, deps: {
    storage: StorageManager<T>,
    firestore: FirestoreManager<T>,
    metadataManager: MetadataManager<T>,
  }): SetOperation<T> {
    const op = new SetOperation<T>(
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
