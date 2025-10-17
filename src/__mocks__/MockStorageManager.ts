// Mock implementations for testing Ganon SDK

import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';
import { IStorageManager } from '../models/interfaces/IStorageManager';
import { ICloudManager, RemoteMetadata } from '../models/interfaces/ICloudManager';
import { SyncStatus } from '../models/sync/SyncStatus';
import { CloudBackupConfig } from '../models/config/CloudBackupConfig';
import LocalSyncMetadata from '../models/sync/LocalSyncMetadata';
import { METADATA_KEY } from '../constants';

export interface IStartedHashMap {
  [key: string]: number | null; // where number is the start timestamp, null means it's not started
}

interface MetadataStorage {
  [key: string]: {
    d: string;  // digest
    s: SyncStatus;  // sync status
    v: number;  // version
    t?: 'set' | 'delete';  // operation type
  };
}

// Mock Storage Manager
export class MockStorageManager<T extends BaseStorageMapping> implements IStorageManager<T> {
  private data: Partial<T> = {};
  private cache: Partial<T> = {};
  cacheKeys: string[] = []; // Required by StorageManager

  // Test helpers
  public getStorageSize(): number {
    return Object.keys(this.data).length;
  }

  public getCacheSize(): number {
    return Object.keys(this.cache).length;
  }

  public clearCache(): void {
    this.cache = {};
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.data[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.data[key] = value;
    this._updateCache(key, value);
  }

  remove<K extends keyof T>(key: K): void {
    delete this.data[key];
    this._updateCache(key, undefined);
  }

  upsert<K extends keyof T>(key: K, value: T[K]): void {
    if (this.contains(key)) {
      const existing = this.get(key);
      this.set(key, { ...existing, ...value } as T[K]);
    } else {
      this.set(key, value);
    }
  }

  contains<K extends keyof T>(key: K): boolean {
    return key in this.data;
  }

  clearAllData(): void {
    this.data = {};
    this.cache = {};
    this.cacheKeys = [];
  }

  private getMetadataStorage(): MetadataStorage {
    const stored = this.data[METADATA_KEY as keyof T];
    if (stored) {
      return stored as unknown as MetadataStorage;
    }
    return {};
  }

  private setMetadataStorage(metadataStorage: MetadataStorage): void {
    this.data[METADATA_KEY as keyof T] = metadataStorage as unknown as T[keyof T];
  }

  getMetadata<K extends keyof T>(key: K): LocalSyncMetadata {
    const metadataStorage = this.getMetadataStorage();
    const meta = metadataStorage[String(key)] || {
      d: '',
      s: SyncStatus.Synced,
      v: 0  // Use 0 instead of Date.now() to match LocalMetadataManager
    };

    return {
      digest: meta.d,
      version: meta.v,
      syncStatus: meta.s
    };
  }

  setMetadata<K extends keyof T>(key: K, metadata: Partial<LocalSyncMetadata>): void {
    const metadataStorage = this.getMetadataStorage();
    const current = this.getMetadata(key);
    const updated = { ...current, ...metadata };

    metadataStorage[String(key)] = {
      d: updated.digest,
      v: updated.version,
      s: updated.syncStatus
    };

    this.setMetadataStorage(metadataStorage);
  }

  private _updateCache<K extends keyof T>(key: K, value?: T[K]): void {
    if (value === undefined) {
      delete this.cache[key];
      const keyStr = String(key);
      const index = this.cacheKeys.indexOf(keyStr);
      if (index > -1) {
        this.cacheKeys.splice(index, 1);
      }
      return;
    }

    this.cache[key] = value;
    const keyStr = String(key);
    const index = this.cacheKeys.indexOf(keyStr);

    if (index > -1) {
      this.cacheKeys.splice(index, 1);
    }

    this.cacheKeys.push(keyStr);
  }
}

// Mock Cloud Manager with controllable behavior
export class MockCloudManager<T extends BaseStorageMapping> implements ICloudManager<T> {
  constructor(
    public identifierKey: string,
    public cloudConfig: CloudBackupConfig<T>
  ) {}

  private cloudStorage = new Map<string, any>();
  private digestMap = new Map<string, string>();
  private remoteMetadata = new Map<string, RemoteMetadata>();
  private currentUserIdentifier: string | null = null;

  // Test control flags
  public shouldFailBackup = false;
  public shouldFailFetch = false;
  public shouldFailDelete = false;
  public networkDelay = 0;
  public failureKeys = new Set<string>();
  public fetchFailureKeys = new Set<string>(); // New property for fetch-specific failures
  public simulateTimeout = false; // New property to simulate timeouts
  
  // Track backup calls for testing
  public backupCallCount: Record<string, number> = {}; // New property to track backup calls per key

  /**
   * Sets the current user identifier for cloud operations
   * @param userIdentifier - The actual user identifier value (e.g., "user@example.com")
   */
  setCurrentUser(userIdentifier: string): void {
    if (!userIdentifier || userIdentifier.trim() === '') {
      throw new Error('User identifier cannot be empty');
    }
    this.currentUserIdentifier = userIdentifier.trim();
  }

  /**
   * Clears the current user identifier
   */
  clearCurrentUser(): void {
    this.currentUserIdentifier = null;
  }

  /**
   * Gets the current user identifier
   * @returns The current user identifier or null if not set
   */
  getCurrentUser(): string | null {
    return this.currentUserIdentifier;
  }

  /**
   * Checks if a user is currently logged in
   * @returns True if a user is logged in, false otherwise
   */
  isUserLoggedIn(): boolean {
    return this.currentUserIdentifier !== null;
  }

  // Test helpers
  public getCloudStorageSize(): number {
    return this.cloudStorage.size;
  }

  public setCloudData<K extends keyof T>(key: K, value: T[K], digest?: string): void {
    this.cloudStorage.set(String(key), value);
    if (digest) {
      this.digestMap.set(String(key), digest);
    }
  }

  public getCloudData<K extends keyof T>(key: K): T[K] | undefined {
    return this.cloudStorage.get(String(key));
  }

  public clearCloudStorage(): void {
    this.cloudStorage.clear();
    this.digestMap.clear();
    this.remoteMetadata.clear();
  }

  public getTotalBackupCalls(): number {
    return Object.values(this.backupCallCount).reduce((sum, count) => sum + count, 0);
  }

  public reset(): void {
    this.shouldFailBackup = false;
    this.shouldFailFetch = false;
    this.shouldFailDelete = false;
    this.networkDelay = 0;
    this.failureKeys.clear();
    this.fetchFailureKeys.clear();
    this.simulateTimeout = false;
    this.backupCallCount = {};
    this.clearCloudStorage();
  }

  private async simulateDelay(): Promise<void> {
    if (this.networkDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.networkDelay));
    }
  }

  private generateDigest(value: any): string {
    return `digest_${JSON.stringify(value).length}_${Date.now()}`;
  }

  async backup(key: Extract<keyof T, string>, value: any): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform backup operations');
    }

    await this.simulateDelay();

    if (this.simulateTimeout) {
      throw new Error(`Network timeout for key: ${key}`);
    }

    if (this.shouldFailBackup || this.failureKeys.has(key)) {
      throw new Error(`Mock backup failure for key: ${key}`);
    }

    const newDigest = this.generateDigest(value);
    this.cloudStorage.set(key, value);
    this.digestMap.set(key, newDigest);

    // Track backup calls
    this.backupCallCount[key] = (this.backupCallCount[key] || 0) + 1;
  }

  async fetch(key: Extract<keyof T, string>): Promise<T[keyof T] | undefined> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform fetch operations');
    }

    await this.simulateDelay();

    if (this.simulateTimeout) {
      throw new Error(`Network timeout for key: ${key}`);
    }

    if (this.shouldFailFetch || this.failureKeys.has(key) || this.fetchFailureKeys.has(key)) {
      throw new Error(`Mock fetch failure for key: ${key}`);
    }

    return this.cloudStorage.get(key);
  }

  async delete(key: Extract<keyof T, string>): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform delete operations');
    }

    await this.simulateDelay();

    if (this.shouldFailDelete || this.failureKeys.has(key)) {
      throw new Error(`Mock delete failure for key: ${key}`);
    }

    this.cloudStorage.delete(key);
    this.digestMap.delete(key);
  }

  async confirm(key: Extract<keyof T, string>, digest: string): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform confirm operations');
    }

    await this.simulateDelay();
    this.digestMap.set(key, digest);
  }

  async dangerouslyDelete(): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform dangerous delete operations');
    }

    await this.simulateDelay();
    this.clearCloudStorage();
  }

  async getDigest(key: Extract<keyof T, string>): Promise<string> {
    await this.simulateDelay();
    return this.digestMap.get(key) || '';
  }

  async getRemoteMetadata(key: Extract<keyof T, string>): Promise<RemoteMetadata | undefined> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to get remote metadata');
    }

    await this.simulateDelay();
    return this.remoteMetadata.get(String(key));
  }

  async setRemoteMetadata(key: Extract<keyof T, string>, metadata: RemoteMetadata): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to set remote metadata');
    }

    await this.simulateDelay();
    this.remoteMetadata.set(String(key), metadata);
  }
}

// Mock Sync Metadata Manager
export class MockSyncMetadataManager<T extends BaseStorageMapping> {
  private metadata = new Map<string, LocalSyncMetadata>();

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

  public clearMetadata(): void {
    this.metadata.clear();
  }

  get<K extends keyof T>(key: K): LocalSyncMetadata {
    return this.metadata.get(String(key)) || {
      digest: '',
      syncStatus: SyncStatus.Synced,
      version: 0  // Use 0 instead of Date.now() to match LocalMetadataManager
    };
  }

  has<K extends keyof T>(key: K): boolean {
    return this.metadata.has(String(key));
  }

  set<K extends keyof T>(key: K, partial: Partial<LocalSyncMetadata>): void {
    const current = this.get(key);
    const updated = { ...current, ...partial };
    this.metadata.set(String(key), updated);
  }

  remove<K extends keyof T>(key: K): void {
    this.metadata.delete(String(key));
  }

  clear(): void {
    this.metadata.clear();
  }
}

// Test utilities
export const TestUtils = {
  createTestData: () => ({
    id: 'test-user-123',
    name: 'Test User',
    email: 'test@example.com'
  }),

  createLargeTestData: (size: number = 1000) => {
    const data: Record<string, any> = {};
    for (let i = 0; i < size; i++) {
      data[`item_${i}`] = {
        id: i,
        name: `Item ${i}`,
        description: `Description for item ${i}`.repeat(10),
        metadata: {
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          tags: [`tag1_${i}`, `tag2_${i}`, `tag3_${i}`]
        }
      };
    }
    return data;
  },

  waitForCondition: async (
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<void> => {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }

    throw new Error(`Condition not met within ${timeout}ms`);
  },

  waitForPromises: async (): Promise<void> => {
    // Wait for all promises in the microtask queue to complete
    await Promise.resolve();
    await Promise.resolve();
    // Wait for any timers
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

