import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';
import { SyncStatus } from '../models/sync/SyncStatus';
import LocalSyncMetadata from '../models/sync/LocalSyncMetadata';
import { SyncMetadata } from '../models/sync/SyncMetadata';
import MetadataManager from '../metadata/MetadataManager';

export class MockMetadataManager<T extends BaseStorageMapping> extends MetadataManager<T> {
  private metadata = new Map<string, LocalSyncMetadata>();

  constructor() {
    // Pass empty objects for required constructor params since we're mocking everything
    super({} as any, {} as any, {} as any);
  }

  get(key: Extract<keyof T, string>): LocalSyncMetadata {
    return this.metadata.get(String(key)) || {
      digest: '',
      syncStatus: SyncStatus.Synced,
      version: 0
    };
  }

  has(key: Extract<keyof T, string>): boolean {
    return this.metadata.has(String(key));
  }

  async set(key: Extract<keyof T, string>, metadata: LocalSyncMetadata): Promise<void> {
    this.metadata.set(String(key), metadata);
  }

  updateSyncStatus(key: Extract<keyof T, string>, status: SyncStatus): void {
    const current = this.get(key);
    this.set(key, { ...current, syncStatus: status });
  }

  remove(key: Extract<keyof T, string>): void {
    this.metadata.delete(String(key));
  }

  clear(): void {
    this.metadata.clear();
  }

  // Implement required async methods from MetadataManager
  async hydrateMetadata(): Promise<void> {
    // No-op for tests
  }

  async needsHydration(_key: Extract<keyof T, string>): Promise<boolean> {
    return false;
  }

  async ensureConsistency(key: Extract<keyof T, string>): Promise<SyncMetadata | undefined> {
    return this.get(key);
  }

  async invalidateCache(_key: Extract<keyof T, string>): Promise<void> {
    // No-op for tests
  }

  // Test helpers
  public getMetadataSize(): number {
    return this.metadata.size;
  }

  public getAllMetadata(): Record<string, LocalSyncMetadata> {
    const result: Record<string, LocalSyncMetadata> = {};
    this.metadata.forEach((value, key) => {
      result[key] = { ...value };
    });
    return result;
  }
}
