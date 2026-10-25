interface SyncOperationResult<T> {
  success: boolean;
  key?: Extract<keyof T, string>;
  error?: Error;
  shouldRetry?: boolean;
  /** Remote/local writes were skipped because the enqueue-time session is stale. */
  aborted?: boolean;
}

export default SyncOperationResult;
