import { jest } from '@jest/globals';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import MetadataManager from '../../metadata/MetadataManager';
import UserManager from '../../managers/UserManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { MockMetadataManager } from '../../__mocks__/MockMetadataManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import { CloudBackupConfig } from '../../models/config/CloudBackupConfig';

/**
 * Creates a mock StorageManager with internal storage that properly tracks set/get operations
 */
export function createMockStorageManager<T extends BaseStorageMapping>(): jest.Mocked<StorageManager<T>> {
  const storageData = new Map<string, any>();
  
  return ({
    get: jest.fn((key: string) => storageData.get(key)),
    set: jest.fn((key: string, value: any) => {
      storageData.set(key, value);
      return undefined;
    }),
    remove: jest.fn((key: string) => {
      storageData.delete(key);
      return undefined;
    }),
    upsert: jest.fn(),
    contains: jest.fn((key: string) => storageData.has(key)),
    clearAllData: jest.fn(() => storageData.clear()),
    cache: {} as any,
    cacheKeys: [] as any,
    _updateCache: jest.fn()
  } as unknown) as jest.Mocked<StorageManager<T>>;
}

/**
 * Creates a mock FirestoreManager with all necessary methods
 */
export function createMockFirestoreManager<T extends BaseStorageMapping>(): jest.Mocked<FirestoreManager<T>> {
  return ({
    identifierKey: 'mock',
    cloudConfig: {} as any,
    adapter: {} as any,
    backup: jest.fn<
      (key: Extract<keyof T, string>, value: any, options?: { transaction?: any }) => Promise<void>
    >().mockResolvedValue(undefined),
    fetch: jest.fn<
      (key: Extract<keyof T, string>) => Promise<any>
    >().mockResolvedValue(undefined),
    delete: jest.fn<
      (key: Extract<keyof T, string>) => Promise<void>
    >().mockResolvedValue(undefined),
    runTransaction: (jest.fn(<R>(callback: (transaction: any) => Promise<R>) => callback({})) as unknown) as FirestoreManager<T>["runTransaction"],
    dangerouslyDelete: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    _backupDocumentField: async () => {},
    _backupSubcollection: async () => {},
    referenceManager: {} as any,
    dataProcessor: {} as any,
    chunkManager: {} as any,
    userManager: {} as any
  } as unknown) as jest.Mocked<FirestoreManager<T>>;
}

/**
 * Creates a mock MetadataManager with all necessary methods
 */
export function createMockMetadataManager<T extends BaseStorageMapping>(): jest.Mocked<MetadataManager<T>> {
  return ({
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
    updateSyncStatus: jest.fn(),
    hydrateMetadata: jest.fn(),
    needsHydration: jest.fn(),
    ensureConsistency: jest.fn(),
    invalidateCache: jest.fn(),
    cancelPendingOperations: jest.fn()
  } as unknown) as jest.Mocked<MetadataManager<T>>;
}

/**
 * Creates a mock UserManager with basic functionality
 */
export function createMockUserManager<T extends BaseStorageMapping>(): jest.Mocked<UserManager<T>> {
  return ({
    getCurrentUser: jest.fn(),
    isUserLoggedIn: jest.fn().mockReturnValue(true),
    login: jest.fn(),
    logout: jest.fn(),
    setCurrentUser: jest.fn(),
    clearCurrentUser: jest.fn()
  } as unknown) as jest.Mocked<UserManager<T>>;
}

/**
 * Creates a basic GanonConfig for testing
 */
export function createTestConfig<T extends BaseStorageMapping>(
  identifierKey: Extract<keyof T, string> = 'testKey' as Extract<keyof T, string>,
  cloudConfig?: CloudBackupConfig<T>
): GanonConfig<T> {
  return {
    identifierKey,
    cloudConfig: cloudConfig || {
      test: {
        docKeys: ['testKey', 'anotherKey'] as Extract<keyof T, string>[],
        subcollectionKeys: [] as Extract<keyof T, string>[],
      }
    },
    syncInterval: 1000
  };
}

/**
 * Creates a complete set of mock dependencies for testing operations
 */
export function createMockDependencies<T extends BaseStorageMapping>(
  identifierKey: Extract<keyof T, string> = 'testKey' as Extract<keyof T, string>
) {
  const storage = createMockStorageManager<T>();
  const firestore = createMockFirestoreManager<T>();
  const metadataManager = createMockMetadataManager<T>();
  const userManager = createMockUserManager<T>();
  
  return {
    storage,
    firestore,
    metadataManager,
    userManager,
    config: createTestConfig<T>(identifierKey)
  };
}

/**
 * Creates a MockMetadataManager instance for testing
 */
export function createMockMetadataManagerInstance<T extends BaseStorageMapping>(): MockMetadataManager<T> {
  return new MockMetadataManager<T>();
}

/**
 * Sets up common test data in storage and metadata
 */
export function setupTestData<T extends BaseStorageMapping>(
  storage: jest.Mocked<StorageManager<T>>,
  metadataManager: jest.Mocked<MetadataManager<T>>,
  testData: Record<string, any> = {}
) {
  // Setup default test data
  const defaultData: Record<string, any> = {
    testKey: 'test-value',
    anotherKey: 42,
    ...testData
  };

  // Setup storage mock to return test data
  storage.get.mockImplementation((key) => {
    return defaultData[key as string];
  });

  // Setup metadata mock to return different digests to trigger operations
  metadataManager.get.mockImplementation((key) => {
    const value = defaultData[key as string];
    if (value !== undefined) {
      return {
        syncStatus: 'synced' as any,
        digest: `old-digest-${key}`,
        version: 1
      };
    }
    return undefined;
  });
} 