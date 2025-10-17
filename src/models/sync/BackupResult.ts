export interface BackupResult {
  success: boolean;
  backedUpKeys: string[];
  failedKeys: string[];
  skippedKeys: string[];
  timestamp: Date;
}
