import { SubcollectionPayloadKind } from './RemoteDigestEntry';

export interface SyncMetadata {
  // also stored in cloud
  digest: string;
  version: number; // timestamp of the sync
  /** Remote subcollection payload kind (from digestMap); not set for doc keys. */
  k?: SubcollectionPayloadKind;
}
