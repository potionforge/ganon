import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { BackupResult } from "../sync/BackupResult";
import { RestoreResult } from "../sync/RestoreResult";
import { IntegrityFailureConfig } from "../config/IntegrityFailureConfig";
import { ConflictResolutionConfig } from "../config/ConflictResolutionConfig";
import type { GanonEventName, GanonEventListener } from "../events/GanonEvents";

export interface IGanon<T extends BaseStorageMapping> {
  // Core CRUD operations with full type safety
  get<K extends keyof T>(key: K): T[K] | undefined;
  getOrDefault<K extends keyof T>(key: K, fallback: T[K]): T[K];
  set<K extends Extract<keyof T, string>>(key: K, value: T[K]): void;
  remove<K extends Extract<keyof T, string>>(key: K): void;
  upsert<K extends Extract<keyof T, string>>(key: K, value: Partial<T[K]>): void;
  contains<K extends keyof T>(key: K): boolean;

  // Login lifecycle
  login(userId: string): Promise<'noop' | 'restore' | 'backup'>;
  logout(options?: { backup?: boolean }): Promise<void>;
  isUserLoggedIn(): boolean;
  whenHydrated(): Promise<void>;

  // Sync operations
  startSync(): void;
  stopSync(): void;
  backup(): Promise<BackupResult>;
  restore(): Promise<RestoreResult>;
  hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult>;
  dangerouslyDelete(): Promise<void>;
  clearAllData(): void;

  // Events
  on<N extends GanonEventName>(event: N, listener: GanonEventListener<N>): void;
  off<N extends GanonEventName>(event: N, listener: GanonEventListener<N>): void;
  once<N extends GanonEventName>(event: N, listener: GanonEventListener<N>): void;

  // Logging operations
  setLogLevel(logLevel: number): void;

  // Cleanup operations
  destroy(): void;
}
