export enum SyncErrorType {
  SyncConflict = 'SyncConflict',
  SyncFailed = 'SyncFailed',
  SyncTimeout = 'SyncTimeout',
  SyncNetworkError = 'SyncNetworkError',
  SyncValidationError = 'SyncValidationError',
  SyncConfigurationError = 'SyncConfigurationError',
  SyncMultipleErrors = 'SyncMultipleErrors',
  IntegrityFailure = 'IntegrityFailure',
}

class SyncError extends Error {
  constructor(
    message: string,
    readonly type: SyncErrorType,
    readonly retryCount?: number,
    readonly childErrors?: SyncError[]
  ) {
    super(message);

    Object.setPrototypeOf(this, SyncError.prototype);

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SyncError);
    }
  }

  /**
   * Creates a SyncError that aggregates multiple child errors
   */
  static createMultipleErrors(childErrors: SyncError[], message?: string): SyncError {
    const defaultMessage = `Multiple sync errors occurred: ${childErrors.length} errors`;
    return new SyncError(
      message || defaultMessage,
      SyncErrorType.SyncMultipleErrors,
      undefined,
      childErrors
    );
  }

  /**
   * Gets all error messages including child errors
   */
  getAllMessages(): string[] {
    const messages = [this.message];
    if (this.childErrors) {
      this.childErrors.forEach(error => {
        messages.push(...error.getAllMessages());
      });
    }
    return messages;
  }
}

/**
 * Specialized error for integrity failures during sync operations
 */
export class IntegrityFailureError extends SyncError {
  constructor(
    key: string,
    computedHash: string,
    remoteHash: string,
    attempts: number
  ) {
    super(
      `Integrity failure for key ${key} after ${attempts} attempts. Computed: ${computedHash}, Remote: ${remoteHash}`,
      SyncErrorType.IntegrityFailure
    );
    
    this.key = key;
    this.computedHash = computedHash;
    this.remoteHash = remoteHash;
    this.attempts = attempts;
  }

  readonly key: string;
  readonly computedHash: string;
  readonly remoteHash: string;
  readonly attempts: number;
}

export default SyncError;
