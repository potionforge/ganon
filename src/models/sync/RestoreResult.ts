export interface IntegrityFailureInfo {
  key: string;
  computedHash: string;
  remoteHash: string;
  attempts: number;
  recoveryStrategy?: string;
}

export interface RestoreResult {
  success: boolean;
  restoredKeys: string[];
  failedKeys: string[];
  integrityFailures: IntegrityFailureInfo[];
  timestamp: Date;
  /** True when the pass was invalidated mid-flight (e.g. stopSync bumped the session). */
  aborted?: true;
}
