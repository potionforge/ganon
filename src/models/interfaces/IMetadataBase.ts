import { BaseStorageMapping } from "../storage/BaseStorageMapping";
import { SyncMetadata } from "../sync/SyncMetadata";
import { SyncStatus } from "../sync/SyncStatus";

export default interface IMetadataBase<T extends BaseStorageMapping> {
  get(key: Extract<keyof T, string>): SyncMetadata;
  has(key: Extract<keyof T, string>): boolean;
  set(key: Extract<keyof T, string>, metadata: Partial<SyncMetadata>): void;
  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): void;
  remove(key: Extract<keyof T, string>): void;
  clear(): void;
}
