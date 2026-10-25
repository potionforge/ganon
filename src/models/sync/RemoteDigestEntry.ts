import { SyncStatus } from './SyncStatus';

/** In-document digestMap entry (and cached remote metadata shape). */
export type SubcollectionPayloadKind = 'array' | 'object';

export interface RemoteDigestEntry {
  d: string;
  v: number;
  /** Subcollection payload encoding; omitted for doc keys and legacy rows. */
  k?: SubcollectionPayloadKind;
  s?: SyncStatus;
}
