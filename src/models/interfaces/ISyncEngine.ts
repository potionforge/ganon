import { RestoreResult } from "../../models/sync/RestoreResult";
import { BackupResult } from "../sync/BackupResult";
import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { SyncStatus } from "../sync/SyncStatus";
import { IntegrityFailureConfig } from "../config/IntegrityFailureConfig";
import { ConflictResolutionConfig } from "../config/ConflictResolutionConfig";
import type { RemoteDataProbeResult } from "../sync/RemoteDataProbeResult";

export interface ISyncEngine<T extends BaseStorageMapping> {
  start(): void;
  stop(): void;
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
  getSyncStatus(key: Extract<keyof T, string>): SyncStatus | undefined;
  getKeysByStatus(status: SyncStatus): Extract<keyof T, string>[];
  getSyncStatusSummary(): Record<SyncStatus, number>;
  hasPendingOperations(): boolean;
  hasAnyRemoteData(): Promise<boolean>;
  /**
   * Discriminated remote-tenure probe. Use this (not hasAnyRemoteData) when choosing
   * backup vs restore — indeterminate must not select backup.
   */
  probeRemoteData(): Promise<RemoteDataProbeResult>;
  cancelPendingOperations(): void;
}
