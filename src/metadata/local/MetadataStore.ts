import StorageManager from "../../managers/StorageManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import { SyncStatus } from "../../models/sync/SyncStatus";
import { METADATA_KEY } from "../../constants";
import Log from "../../utils/Log";
import MetadataStorage from "../../models/sync/MetadataStorage";
import LocalSyncMetadata from "../../models/sync/LocalSyncMetadata";
import { SyncMetadata } from "../../models/sync/SyncMetadata";

/**
 * Synchronous local metadata store. Never returns undefined on get;
 * never persists synthesized defaults on read (I1, I2).
 */
export default class MetadataStore<T extends BaseStorageMapping> {
  private data: MetadataStorage = {};
  private isDirty = false;

  constructor(private storage: StorageManager<T>) {
    this._load();
  }

  get<K extends keyof T>(key: K): LocalSyncMetadata {
    Log.verbose(`Ganon: MetadataStore.get, key: ${String(key)}`);
    const meta = this.data[String(key)] || {
      d: '',
      s: SyncStatus.Synced,
      v: 0,
    };

    return {
      digest: meta.d,
      version: meta.v,
      syncStatus: meta.s || SyncStatus.Synced,
    };
  }

  isNeverSynced<K extends keyof T>(key: K): boolean {
    return this.get(key).digest === '';
  }

  has<K extends keyof T>(key: K): boolean {
    return this.data[String(key)] !== undefined;
  }

  /** Local edit that will be flushed to remote metadata map. */
  recordLocalChange<K extends keyof T>(key: K, metadata: LocalSyncMetadata): void {
    this._persist(key, metadata);
  }

  /** Hydration/restore: update local state without scheduling remote flush (I3). */
  recordSyncedState<K extends keyof T>(key: K, metadata: LocalSyncMetadata): void {
    this._persist(key, { ...metadata, syncStatus: metadata.syncStatus ?? SyncStatus.Synced });
  }

  updateSyncStatus<K extends keyof T>(key: K, status: SyncStatus): void {
    const current = this.get(key);
    this._persist(key, { ...current, syncStatus: status });
  }

  remove<K extends keyof T>(key: K): void {
    if (this.data[String(key)]) {
      delete this.data[String(key)];
      this.isDirty = true;
      this._save();
    }
  }

  clear(): void {
    this.data = {};
    this.isDirty = true;
    this._save();
  }

  /** @deprecated use recordLocalChange / recordSyncedState */
  set<K extends keyof T>(key: K, metadata: LocalSyncMetadata): void {
    this._persist(key, metadata);
  }

  private _persist<K extends keyof T>(key: K, metadata: SyncMetadata | LocalSyncMetadata): void {
    const current = this.get(key);
    const updated = { ...current, ...metadata };
    this.data[String(key)] = {
      d: updated.digest ?? '',
      v: updated.version ?? current.version,
      s: updated.syncStatus,
    };
    this.isDirty = true;
    this._save();
  }

  private _load(): void {
    const stored = this.storage.get(METADATA_KEY as keyof T);
    if (stored) {
      this.data = stored as unknown as MetadataStorage;
    }
  }

  private _save(): void {
    if (this.isDirty) {
      this.storage.set(METADATA_KEY as keyof T, this.data as unknown as T[keyof T]);
      this.isDirty = false;
    }
  }
}
