import { SyncMetadata } from '../../models/sync/SyncMetadata';
import MetadataStorage from '../../models/sync/MetadataStorage';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { REMOTE_METADATA_KEY, DIGEST_MAP_KEY } from '../../constants';
import SyncError, { SyncErrorType } from '../../errors/SyncError';
import UserManager from '../../managers/UserManager';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { DigestReadMode, selectRemoteDigest } from '../digest/selectRemoteDigest';
import DataProcessor from '../../firestore/processing/DataProcessor';

interface CacheState {
  data: MetadataStorage;
  lastFetchTime: number;
  invalidated: boolean;
}

/**
 * Read-side remote metadata cache with TTL and in-flight fetch dedupe.
 * Epoch invalidation discards in-flight fetch write-backs (same pattern as hydration generation).
 */
export default class RemoteMetadataCache<T extends BaseStorageMapping> {
  private cache: CacheState = { data: {}, lastFetchTime: 0, invalidated: true };
  private fetchPromise: Promise<void> | null = null;
  private docRef: FirebaseFirestoreTypes.DocumentReference | null = null;
  /** Bumped on invalidate(); in-flight fetches capture epoch at start and skip write-back if it changed. */
  private epoch = 0;

  constructor(
    private referenceManager: FirestoreReferenceManager<T>,
    private adapter: FirestoreAdapter<T>,
    private userManager: UserManager<T>,
    private documentKey: string,
    private maxAgeMs: number,
    private digestReadMode: DigestReadMode = 'dual',
    private dataProcessor: DataProcessor = new DataProcessor()
  ) {}

  async fetch(keys?: string[]): Promise<MetadataStorage> {
    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot get remote metadata: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (!this._needsFetch() && !keys) {
      return this.cache.data;
    }

    if (this.fetchPromise) {
      await this.fetchPromise;
      return this.cache.data;
    }

    const fetchPromise = this._doFetch(keys);
    this.fetchPromise = fetchPromise;
    try {
      await fetchPromise;
    } finally {
      // Only clear our own handle. invalidate() may have released it mid-flight and a
      // fresh fetch may now own fetchPromise — don't clobber the newer in-flight handle
      // (same identity guard as hydrationPromise's generation-checked finally).
      if (this.fetchPromise === fetchPromise) {
        this.fetchPromise = null;
      }
    }
    return this.cache.data;
  }

  /** Lazy invalidation: mark stale and bump epoch so in-flight fetches discard write-back. */
  invalidate(): void {
    this.epoch += 1;
    this.cache.invalidated = true;
    this.cache.lastFetchTime = 0;
    // Release the dedupe handle so a subsequent fetch() runs fresh instead of awaiting the
    // now epoch-dead in-flight fetch (mirrors SyncEngine.stop() releasing hydrationPromise).
    this.fetchPromise = null;
  }

  getCached(): MetadataStorage {
    return this.cache.data;
  }

  mergeIntoCache(updates: MetadataStorage): void {
    Object.assign(this.cache.data, updates);
    this.cache.lastFetchTime = Date.now();
    this.cache.invalidated = false;
  }

  private _needsFetch(): boolean {
    if (this.cache.invalidated || !this.cache.lastFetchTime) return true;
    return Date.now() - this.cache.lastFetchTime > this.maxAgeMs;
  }

  private _getDocRef(): FirebaseFirestoreTypes.DocumentReference {
    if (!this.docRef) {
      const backupRef = this.referenceManager.getBackupRef();
      this.docRef = this.referenceManager.getDocumentRef(backupRef, this.documentKey);
    }
    return this.docRef;
  }

  private async _doFetch(specificKeys?: string[]): Promise<void> {
    const fetchEpoch = this.epoch;
    const doc = await this.adapter.getDocument(this._getDocRef());
    if (fetchEpoch !== this.epoch) {
      return;
    }
    if (doc.exists) {
      const docData = doc.data() ?? {};
      const legacyMetadata = (docData[REMOTE_METADATA_KEY] as MetadataStorage) || {};
      const digestMap = (docData[DIGEST_MAP_KEY] as MetadataStorage) || {};
      const remoteMetadata = this._mergeDigestSources(legacyMetadata, digestMap, specificKeys);

      if (specificKeys) {
        for (const key of specificKeys) {
          if (remoteMetadata[key]) {
            this.cache.data[key] = remoteMetadata[key];
          }
        }
      } else {
        this.cache.data = remoteMetadata;
      }
      this.cache.lastFetchTime = Date.now();
      this.cache.invalidated = false;
    }
  }

  private _mergeDigestSources(
    legacyMetadata: MetadataStorage,
    digestMap: MetadataStorage,
    specificKeys?: string[]
  ): MetadataStorage {
    const keys = specificKeys ?? [
      ...new Set([...Object.keys(legacyMetadata), ...Object.keys(digestMap)]),
    ];
    const merged: MetadataStorage = { ...this.cache.data };

    for (const key of keys) {
      const sanitizedKey = this.dataProcessor.sanitizeFieldName(key);
      const legacy = legacyMetadata[key] ?? legacyMetadata[sanitizedKey];
      const inDoc = digestMap[key] ?? digestMap[sanitizedKey];
      const selected = selectRemoteDigest(legacy, inDoc, this.digestReadMode);
      if (selected) {
        merged[key] = selected;
      }
    }

    return merged;
  }

  hasConflict(local: SyncMetadata, remote: { d: string; v: number }): boolean {
    if (remote.v <= local.version) return false;
    return remote.d !== local.digest && !this.fetchPromise;
  }
}
