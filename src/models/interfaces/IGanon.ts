import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { BackupResult } from "../sync/BackupResult";
import { RestoreResult } from "../sync/RestoreResult";
import { IntegrityFailureConfig } from "../config/IntegrityFailureConfig";
import { ConflictResolutionConfig } from "../config/ConflictResolutionConfig";

export interface IGanon<T extends BaseStorageMapping> {
  // Core CRUD operations with full type safety
  get<K extends keyof T>(key: K): T[K] | undefined;
  set<K extends Extract<keyof T, string>>(key: K, value: T[K]): void;
  remove<K extends Extract<keyof T, string>>(key: K): void;
  upsert<K extends Extract<keyof T, string>>(key: K, value: T[K]): void;
  contains<K extends keyof T>(key: K): boolean;

  // Sync operations
  startSync(): void;
  stopSync(): void;
  backup(): Promise<BackupResult>;
  restore(): Promise<RestoreResult>;
  hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  dangerouslyDelete(): Promise<void>;
  clearAllData(): void;

  // Logging operations
  setLogLevel(logLevel: number): void;

  // Cleanup operations
  destroy(): void;
}
