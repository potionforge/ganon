import { SyncStatus } from "./SyncStatus";

interface MetadataStorage {
  [key: string]: {
    d: string;  // digest
    v: number;  // version
    s?: SyncStatus;  // sync status
  };
}

export default MetadataStorage;