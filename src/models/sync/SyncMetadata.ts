export interface SyncMetadata {
  // also stored in cloud
  digest: string;
  version: number; // timestamp of the sync
}
