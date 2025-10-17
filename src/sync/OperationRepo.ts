import NetworkMonitor from "../utils/NetworkMonitor";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import ISyncOperation from "../models/interfaces/ISyncOperation";
import Log from "../utils/Log";
import SyncOperationResult from "../models/sync/SyncOperationResult";
import { BATCH_SIZE } from "../constants";
import { MMKV } from "react-native-mmkv";
import BaseSyncOperation from "./operations/BaseSyncOperation";
import SetOperation from "./operations/SetOperation";
import DeleteOperation from "./operations/DeleteOperation";
import StorageManager from "../managers/StorageManager";
import FirestoreManager from "../firestore/FirestoreManager";
import MetadataManager from "../metadata/MetadataManager";

const PENDING_OPERATIONS_KEY = 'ganon_pending_operations';

type OperationType = 'set' | 'delete';

interface SerializedOperation {
  type: OperationType;
  key: string;
  retryCount: number;
  maxRetries: number;
}

interface OperationDependencies<T extends BaseStorageMapping> {
  storage: StorageManager<T>;
  firestore: FirestoreManager<T>;
  metadataManager: MetadataManager<T>;
}

type OperationClass<T extends BaseStorageMapping> = {
  new(key: Extract<keyof T, string>, storage: StorageManager<T>, firestore: FirestoreManager<T>, metadataManager: MetadataManager<T>): BaseSyncOperation<T>;
  deserialize(data: SerializedOperation, deps: OperationDependencies<T>): BaseSyncOperation<T>;
}

export default class OperationRepo<T extends BaseStorageMapping> {
  private _syncInProgress = false;
  private _pendingOperations: Map<Extract<keyof T, string>, ISyncOperation<T>> = new Map();
  private _storage: MMKV;
  private _deps: OperationDependencies<T> | null = null;

  constructor(
    private networkMonitor: NetworkMonitor,
    deps?: OperationDependencies<T>
  ) {
    this._storage = new MMKV({ id: 'ganon_operations' });
    if (deps) {
      this._deps = deps;
      this._loadPendingOperations();
    }
  }

  private _getOperationClass(type: OperationType): OperationClass<T> {
    switch (type) {
      case 'set':
        return SetOperation as OperationClass<T>;
      case 'delete':
        return DeleteOperation as OperationClass<T>;
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }
  }

  private _loadPendingOperations() {
    if (!this._deps) {
      Log.warn('Ganon: Cannot load pending operations without dependencies');
      return;
    }

    try {
      const stored = this._storage.getString(PENDING_OPERATIONS_KEY);
      if (stored) {
        const operations = JSON.parse(stored) as SerializedOperation[];
        operations.forEach(opData => {
          try {
            // Validate operation data
            if (!opData.type || !['set', 'delete'].includes(opData.type)) {
              Log.error(`Ganon: Invalid operation type: ${opData.type}`);
              return;
            }
            if (!opData.key) {
              Log.error(`Ganon: Missing key in operation data`);
              return;
            }
            if (typeof opData.retryCount !== 'number') {
              Log.error(`Ganon: Invalid retryCount in operation data for key ${opData.key}`);
              return;
            }

            const OperationClass = this._getOperationClass(opData.type);
            const operation = OperationClass.deserialize(opData, this._deps!);
            this._pendingOperations.set(opData.key as Extract<keyof T, string>, operation);
            Log.verbose(`Ganon: Restored ${opData.type} operation for key: ${opData.key}`);
          } catch (error) {
            Log.error(`Ganon: Failed to restore operation for key ${opData.key}: ${error}`);
          }
        });
      }
    } catch (error) {
      Log.error('Ganon: Error loading pending operations: ' + String(error));
    }
  }

  private _savePendingOperations() {
    try {
      const operations = Array.from(this._pendingOperations.values())
        .filter((op): op is BaseSyncOperation<T> => op instanceof BaseSyncOperation)
        .map(op => op.serialize());
      this._storage.set(PENDING_OPERATIONS_KEY, JSON.stringify(operations));
    } catch (error) {
      Log.error('Ganon: Error saving pending operations: ' + String(error));
    }
  }

  setDependencies(deps: OperationDependencies<T>) {
    this._deps = deps;
    this._loadPendingOperations();
  }

  addOperation(key: Extract<keyof T, string>, operation: ISyncOperation<T>) {
    Log.verbose(`Ganon: OperationRepo.addOperation, key: ${String(key)}`);
    this._pendingOperations.set(key, operation);
    this._savePendingOperations();
  }

  removeOperation(key: Extract<keyof T, string>) {
    Log.verbose(`Ganon: OperationRepo.removeOperation, key: ${String(key)}`);
    this._pendingOperations.delete(key);
    this._savePendingOperations();
  }

  clearAll() {
    Log.verbose('Ganon: OperationRepo.clearAll');
    this._pendingOperations.clear();
    this._storage.delete(PENDING_OPERATIONS_KEY);
  }

  async processOperations(): Promise<SyncOperationResult<T>[]> {
    Log.verbose('Ganon: OperationRepo.processOperations');
    if (this._syncInProgress) {
      Log.verbose("Ganon: skipping sync because another sync is in progress");
      return [];
    }

    if (!this.networkMonitor.isOnline()) {
      Log.verbose("Ganon: skipping sync because network is offline");
      return [];
    }

    if (this._pendingOperations.size === 0) {
      Log.verbose("Ganon: skipping sync because no operations are pending");
      return [];
    }

    this._syncInProgress = true;
    const results: SyncOperationResult<T>[] = [];

    try {
      const operationEntries = Array.from(this._pendingOperations.entries());

      for (let i = 0; i < operationEntries.length; i += BATCH_SIZE) {
        if (!this.networkMonitor.isOnline()) {
          Log.verbose("Ganon: network went offline during sync, stopping");
          break;
        }

        const batch = operationEntries.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async ([key, operation]) => {
          try {
            // Check retry count before executing
            if (operation.getRetryCount() >= operation.getMaxRetries()) {
              Log.verbose(`Ganon: operation ${key} has reached max retries, removing from queue`);
              this._pendingOperations.delete(key);
              return {
                success: false,
                key,
                error: new Error('Operation exceeded max retries'),
                shouldRetry: false
              };
            }

            const result = await operation.execute();

            if (result.success) {
              // Reset retry count on success and remove from queue
              operation.resetRetryCount();
              this._pendingOperations.delete(key);
            } else if (result.shouldRetry) {
              // Increment retry count and check if we should continue retrying
              const canRetry = operation.incrementRetryCount();
              if (!canRetry) {
                Log.verbose(`Ganon: operation ${key} exceeded max retries, removing from queue`);
                this._pendingOperations.delete(key);
              } else {
                Log.verbose(`Ganon: operation ${key} failed, will retry (attempt ${operation.getRetryCount()}/${operation.getMaxRetries()})`);
              }
            } else {
              // Operation failed and shouldn't be retried
              this._pendingOperations.delete(key);
            }

            return result;
          } catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const canRetry = operation.incrementRetryCount();

            const result = {
              success: false,
              key,
              error: errorObj,
              shouldRetry: canRetry,
            };

            if (!canRetry) {
              Log.verbose(`Ganon: operation ${key} exceeded max retries due to exception, removing from queue`);
              this._pendingOperations.delete(key);
            } else {
              Log.verbose(`Ganon: operation ${key} failed with exception, will retry (attempt ${operation.getRetryCount()}/${operation.getMaxRetries()})`);
            }

            return result;
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);
        batchResults.forEach((result, index) => {
          const [key] = batch[index];
          if (result.status === "fulfilled") {
            results.push(result.value as SyncOperationResult<T>);
          } else {
            const errorObj = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
            const failedResult = {
              success: false,
              key,
              error: errorObj,
              shouldRetry: true,
            };
            results.push(failedResult);

            // Don't remove failed operations that should be retried
            if (!failedResult.shouldRetry) {
              this._pendingOperations.delete(key);
            }
          }
        });
      }
    } finally {
      this._syncInProgress = false;
    }

    return results;
  }
}
