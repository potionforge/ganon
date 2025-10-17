interface SyncOperationResult<T> {
  success: boolean;
  key?: Extract<keyof T, string>;
  error?: Error;
  shouldRetry?: boolean;
}

export default SyncOperationResult;
