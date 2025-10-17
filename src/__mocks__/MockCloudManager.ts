import { ICloudManager, RemoteMetadata } from '../models/interfaces/ICloudManager';
import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';
import { CloudBackupConfig } from '../models/config/CloudBackupConfig';
// import { SyncMetadata } from '../models/sync/SyncMetadata'; // Unused for now

export class MockCloudManager<T extends BaseStorageMapping> implements ICloudManager<T> {
  private cloudData: Partial<T> = {};
  private remoteMetadata: Record<string, RemoteMetadata> = {};
  private currentUser: string | undefined;

  public failureKeys = new Set<string>();
  public fetchFailureKeys = new Set<string>(); // For fetch-specific failures
  public simulateTimeout = false; // To simulate timeouts
  public backupCallCount: Record<string, number> = {}; // Track backup calls per key

  constructor(
    public readonly identifierKey: string,
    public readonly cloudConfig: CloudBackupConfig<T>
  ) {}

  /**
   * Sets the current user identifier for cloud operations
   * @param userIdentifier - The actual user identifier value (e.g., "user@example.com")
   */
  setCurrentUser(userIdentifier: string | null): void {
    this.currentUser = userIdentifier || undefined;
  }

  /**
   * Clears the current user identifier
   */
  clearCurrentUser(): void {
    this.currentUser = undefined;
  }

  /**
   * Gets the current user identifier
   * @returns The current user identifier or null if not set
   */
  getCurrentUser(): string | null {
    return this.currentUser || null;
  }

  /**
   * Checks if a user is currently logged in
   * @returns True if a user is logged in, false otherwise
   */
  isUserLoggedIn(): boolean {
    return this.currentUser !== undefined;
  }

  private generateDigest(value: any): string {
    return `digest_${JSON.stringify(value).length}_${Date.now()}`;
  }

  async backup(key: Extract<keyof T, string>, value: any): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform backup operations');
    }

    if (this.simulateTimeout) {
      throw new Error('Timeout error');
    }

    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock backup failure for key: ${String(key)}`);
    }

    // Track backup calls
    const keyStr = String(key);
    this.backupCallCount[keyStr] = (this.backupCallCount[keyStr] || 0) + 1;

    this.cloudData[key] = value;
    // Store digest internally but don't return it
    const digest = this.generateDigest(value);
    this.remoteMetadata[keyStr] = { digest, version: Date.now() };
  }

  async fetch(key: Extract<keyof T, string>): Promise<T[typeof key] | undefined> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform fetch operations');
    }

    if (this.simulateTimeout) {
      throw new Error('Timeout error');
    }
    
    if (this.fetchFailureKeys.has(String(key))) {
      throw new Error(`Mock fetch failure for key: ${String(key)}`);
    }

    return this.cloudData[key];
  }

  async delete(key: Extract<keyof T, string>): Promise<void> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform delete operations');
    }

    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock delete failure for key: ${String(key)}`);
    }

    delete this.cloudData[key];
  }

  async confirm(key: Extract<keyof T, string>, _digest: string): Promise<void> {
    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock confirm failure for key: ${String(key)}`);
    }
    // Mock implementation - no-op
  }

  async getDigest(key: Extract<keyof T, string>): Promise<string> {
    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock getDigest failure for key: ${String(key)}`);
    }

    return `mock-digest-${Date.now()}`;
  }

  async dangerouslyDelete(): Promise<void> {
    this.cloudData = {};
    this.remoteMetadata = {};
  }

  async getRemoteMetadata(key: Extract<keyof T, string>): Promise<RemoteMetadata | undefined> {
    if (!this.isUserLoggedIn()) {
      throw new Error('User must be logged in to perform metadata operations');
    }

    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock getRemoteMetadata failure for key: ${String(key)}`);
    }

    return this.remoteMetadata[String(key)];
  }

  async setRemoteMetadata(key: Extract<keyof T, string>, metadata: RemoteMetadata): Promise<void> {
    if (this.failureKeys.has(String(key))) {
      throw new Error(`Mock setRemoteMetadata failure for key: ${String(key)}`);
    }

    this.remoteMetadata[String(key)] = metadata;
  }

  // Test helpers
  getCloudData<K extends keyof T>(key: K): T[K] | undefined {
    return this.cloudData[key];
  }

  setCloudData<K extends keyof T>(key: K, value: T[K]): void {
    this.cloudData[key] = value;
  }

  reset(): void {
    this.cloudData = {};
    this.remoteMetadata = {};
    this.failureKeys.clear();
    this.fetchFailureKeys.clear();
    this.backupCallCount = {};
  }

  // Test helper for remote metadata
  getRemoteMetadataForTest(key: Extract<keyof T, string>): RemoteMetadata | undefined {
    return this.remoteMetadata[String(key)];
  }

  setRemoteMetadataForTest(_documentName: string, key: Extract<keyof T, string>, metadata: RemoteMetadata): void {
    // For this mock, we ignore the documentName and just use the key directly
    this.remoteMetadata[String(key)] = metadata;
  }

  async hydrate(): Promise<void> {
    // Mock implementation - can be overridden in tests
    return Promise.resolve();
  }
}