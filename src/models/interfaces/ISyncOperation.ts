import SyncOperationResult from "../sync/SyncOperationResult";

export default interface ISyncOperation<T> {
  execute(): Promise<SyncOperationResult<T>>;
  incrementRetryCount(): boolean;
  getRetryCount(): number;
  getMaxRetries(): number;
  resetRetryCount(): void;
}
