import { SyncMetadata } from "./SyncMetadata";
import { SyncStatus } from "./SyncStatus";

export default interface LocalSyncMetadata extends SyncMetadata {
  syncStatus: SyncStatus;
}
