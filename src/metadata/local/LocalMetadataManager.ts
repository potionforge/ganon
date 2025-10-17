import StorageManager from "../../managers/StorageManager";
import { BaseStorageMapping } from "../../models/storage/BaseStorageMapping";
import { SyncStatus } from "../../models/sync/SyncStatus";
import { METADATA_KEY } from "../../constants";
import Log from "../../utils/Log";
import MetadataStorage from "../../models/sync/MetadataStorage";
import IMetadataBase from "../../models/interfaces/IMetadataBase";
import LocalSyncMetadata from "../../models/sync/LocalSyncMetadata";

export default class LocalMetadataManager<T extends BaseStorageMapping> implements IMetadataBase<T> {
  private data: MetadataStorage = {};
  private isDirty = false;

  constructor(private storage: StorageManager<T>) {
    this._load();
  }

  get<K extends keyof T>(key: K): LocalSyncMetadata {
    Log.verbose(`Ganon: SyncMetadataManager.get, key: ${String(key)}`);
    const meta = this.data[String(key)] || {
      d: '',
      s: SyncStatus.Synced,
      v: 0
    };

    return {
      digest: meta.d,
      version: meta.v,
      syncStatus: meta.s || SyncStatus.Synced,
    };
  }

  has<K extends keyof T>(key: K): boolean {
    Log.verbose(`Ganon: SyncMetadataManager.has, key: ${String(key)}`);
    return this.data[String(key)] !== undefined;
  }

  set<K extends keyof T>(key: K, metadata: LocalSyncMetadata): void {
    Log.verbose(`Ganon: SyncMetadataManager.set, key: ${String(key)}, status: ${metadata.syncStatus}`);
    const current = this.get(key);
    const updated = { ...current, ...metadata };

    this.data[String(key)] = {
      d: updated.digest ?? '',
      v: updated.version ?? (current?.version ?? Date.now()),
      s: updated.syncStatus,
    };

    this.isDirty = true;
    this._save();
  }

  /**
   * Updates just the sync status for a key while preserving other metadata.
   * This is a convenience method for common sync status updates.
   * @param key - The key to update
   * @param status - The new sync status
   */
  updateSyncStatus<K extends keyof T>(key: K, status: SyncStatus): void {
    Log.verbose(`Ganon: SyncMetadataManager.updateSyncStatus, key: ${String(key)}, status: ${status}`);
    const current = this.get(key);
    // Preserve existing version and digest when only updating sync status
    this.set(key, { ...current, syncStatus: status });
  }

  remove<K extends keyof T>(key: K): void {
    Log.verbose(`Ganon: SyncMetadataManager.remove, key: ${String(key)}`);
    if (this.data[String(key)]) {
      delete this.data[String(key)];
      this.isDirty = true;
      this._save();
    }
  }

  clear(): void {
    Log.verbose('Ganon: SyncMetadataManager.clear');
    this.data = {};
    this.isDirty = true;
    this._save();
  }

  private _load(): void {
    Log.verbose('Ganon: SyncMetadataManager.load');
    const stored = this.storage.get(METADATA_KEY as keyof T);
    if (stored) {
      this.data = stored as unknown as MetadataStorage;
    }
  }

  private _save(): void {
    Log.verbose('Ganon: SyncMetadataManager.save');
    if (this.isDirty) {
      this.storage.set(METADATA_KEY as keyof T, this.data as unknown as T[keyof T]);
      this.isDirty = false;
    }
  }
}
