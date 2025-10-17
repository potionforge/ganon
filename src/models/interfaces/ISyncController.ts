import { RestoreResult } from "../../models/sync/RestoreResult";
import { BackupResult } from "../sync/BackupResult";
import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { SyncStatus } from "../sync/SyncStatus";
import { IntegrityFailureConfig } from "../config/IntegrityFailureConfig";
import { ConflictResolutionConfig } from "../config/ConflictResolutionConfig";

export interface ISyncController<T extends BaseStorageMapping> {
  startSyncInterval(): void;
  stopSyncInterval(): void;
  syncPending(): void;
  markAsPending(key: Extract<keyof T, string>): void;
  markAsDeleted(key: Extract<keyof T, string>): void;
  syncAll(): Promise<BackupResult>;
  restore(): Promise<RestoreResult>;
  hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  destroy(): void;
  // Sync status utilities
  getSyncStatus(key: Extract<keyof T, string>): SyncStatus | undefined;
  getKeysByStatus(status: SyncStatus): Extract<keyof T, string>[];
  getSyncStatusSummary(): Record<SyncStatus, number>;
  hasPendingOperations(): boolean;
}
