import { SyncStatus } from "../sync/SyncStatus";

export interface TypedDocument<T> {
  key: string;
  value: T;
  version: number;
  lastModified: Date;
  checksum: string;
  syncStatus: SyncStatus;
}
