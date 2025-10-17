import ISyncOperation from "models/interfaces/ISyncOperation";
import { SyncErrorType } from "../../errors/SyncError";
import SyncError from "../../errors/SyncError";
import FirestoreManager from "../../firestore/FirestoreManager";
import StorageManager from "../../managers/StorageManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import SyncOperationResult from "../../models/sync/SyncOperationResult";
import MetadataManager from "../../metadata/MetadataManager";

export default abstract class BaseSyncOperation<T extends BaseStorageMapping> implements ISyncOperation<T> {
  protected retryCount = 0;
  protected maxRetries = 3;
  protected baseRetryDelay = 1_000;

  constructor(
    protected key: Extract<keyof T, string>,
    protected storage: StorageManager<T>,
    protected firestore: FirestoreManager<T>,
    protected metadataManager: MetadataManager<T>
  ) {}

  abstract execute(): Promise<SyncOperationResult<T>>;
  abstract serialize(): object;

  // deserialize is static method

  /**
   * Increments the retry count for this operation.
   * @returns True if the operation can be retried, false if max retries exceeded
   */
  incrementRetryCount(): boolean {
    this.retryCount++;
    return this.retryCount <= this.maxRetries;
  }

  /**
   * Gets the current retry count for this operation.
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Gets the maximum number of retries allowed for this operation.
   */
  getMaxRetries(): number {
    return this.maxRetries;
  }

  /**
   * Resets the retry count to zero.
   */
  resetRetryCount(): void {
    this.retryCount = 0;
  }

  protected getRetryDelay(): number {
    return this.baseRetryDelay * Math.pow(2, this.retryCount);
  }

  protected handleError(error: unknown): SyncOperationResult<T> {
    const syncError = error instanceof SyncError ?
       error :
       new SyncError(`Operation failed: ${error}`, SyncErrorType.SyncFailed);

    return {
      success: false,
      key: this.key,
      error: syncError,
      shouldRetry: this._canRetry(syncError)
    };
  }

  private _canRetry(error: unknown): boolean {
    if (this.retryCount >= this.maxRetries) return false;

    if (error instanceof SyncError) {
      switch (error.type) {
        case SyncErrorType.SyncConfigurationError:
        case SyncErrorType.SyncConflict:
        case SyncErrorType.SyncValidationError:
        case SyncErrorType.SyncMultipleErrors:
          return false;
        default:
          return true;
      }
    }

    return true;
  }
}
