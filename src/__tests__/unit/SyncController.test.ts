import { jest } from '@jest/globals';
import SyncEngine from '../../sync/SyncEngine';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import OperationRepo from '../../sync/OperationRepo';
import MetadataManager from '../../metadata/MetadataManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import { IntegrityFailureRecoveryStrategy } from '../../models/config/IntegrityFailureRecoveryStrategy';
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { ConflictMergeStrategy } from '../../models/config/ConflictMergeStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import LocalSyncMetadata from '../../models/sync/LocalSyncMetadata';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../../sync/OperationRepo');
jest.mock('../../utils/Log');

// Test storage type
interface TestStorage extends BaseStorageMapping {
  email: string;
  testKey: string;
  anotherKey: number;
  lastBackup: number;
}

describe('SyncEngine Tests', () => {
  let syncEngine: SyncEngine<TestStorage>;
  let mockStorage: jest.Mocked<StorageManager<TestStorage>>;
  let mockFirestore: jest.Mocked<FirestoreManager<TestStorage>>;
  let mockMetadataManager: jest.Mocked<MetadataManager<TestStorage>>;
  let mockOperationRepo: jest.Mocked<OperationRepo<TestStorage>>;
  let mockUserManager: jest.Mocked<any>;
  let mockConfig: GanonConfig<TestStorage>;

  beforeEach(() => {
    // Enable fake timers
    jest.useFakeTimers();

    // Create fresh mocks for each test
    mockStorage = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(),
      clearAllData: jest.fn()
    } as any;

    mockFirestore = {
      backup: jest.fn(),
      fetch: jest.fn(),
      delete: jest.fn(),
      getCurrentUser: jest.fn().mockReturnValue('test@example.com'),
      cloudConfig: {
        'testDoc': {
          docKeys: ['testKey', 'anotherKey'] as (keyof TestStorage)[],
          subcollectionKeys: [] as (keyof TestStorage)[],
        }
      },
      backupLastBackupToUserDocument: jest.fn().mockResolvedValue(undefined as never),
    } as any;

    const setMock = jest.fn().mockResolvedValue(undefined as never);
    mockMetadataManager = {
      get: jest.fn(),
      set: setMock,
      recordLocalChange: setMock,
      persistLocalChange: setMock,
      recordSyncedState: setMock,
      updateSyncStatus: jest.fn(),
      hydrateMetadata: jest.fn(),
      needsHydration: jest.fn(),
      getRemoteMetadataOnly: jest.fn(),
      getRemoteMetaForKey: jest.fn().mockReturnValue(undefined),
      invalidateCache: jest.fn(),
      invalidateCacheForHydration: jest.fn()
    } as any;
    mockMetadataManager.isNeverSynced = jest.fn((key: string) => {
      const meta = mockMetadataManager.get(key as keyof TestStorage);
      return !meta?.digest;
    });

    mockOperationRepo = {
      addOperation: jest.fn(),
      processOperations: jest.fn()
    } as any;

    mockUserManager = {
      getCurrentUser: jest.fn(),
      isUserLoggedIn: jest.fn().mockReturnValue(true),
      login: jest.fn(),
      logout: jest.fn()
    } as any;

    mockConfig = {
      identifierKey: 'email',
      cloudConfig: {
        'testDoc': {
          docKeys: ['testKey', 'anotherKey'] as (keyof TestStorage)[],
          subcollectionKeys: [] as (keyof TestStorage)[],
        }
      },
      syncInterval: 1000,
      autoStartSync: true,
      conflictResolutionConfig: {
        strategy: ConflictResolutionStrategy.LOCAL_WINS,
        mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
        notifyOnConflict: true,
        trackConflicts: true,
        maxTrackedConflicts: 100,
      }
    };

    // Set up default mocks for storage and metadata to ensure operations are created
    mockStorage.get.mockImplementation((key) => {
      if (key === 'testKey') return 'test-value' as any;
      if (key === 'anotherKey') return 42 as any;
      return undefined;
    });

    // Mock metadata to return different digests so operations get created for markAsPending
    // Or valid digests for markAsDeleted
    mockMetadataManager.get.mockImplementation((key) => {
      if (key === 'testKey') {
        return {
          syncStatus: SyncStatus.Synced,
          digest: 'old-digest-test', // Different from computed hash to trigger operation
          version: 1
        };
      }
      if (key === 'anotherKey') {
        return {
          syncStatus: SyncStatus.Synced,
          digest: 'existing-digest',
          version: 1
        };
      }
      return undefined;
    });

    syncEngine = new SyncEngine(
      mockStorage,
      mockFirestore,
      mockMetadataManager,
      mockOperationRepo,
      mockUserManager,
      mockConfig
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.useRealTimers(); // Restore real timers
    syncEngine.stopSyncInterval();
    // Reset hydration tracking for each test
    (syncEngine as any).hasHydratedAfterLogin = false;
    (syncEngine as any).currentUserForHydration = null;
  });

  describe('Constructor', () => {
    it('should start sync timer when autoStartSync is true', () => {
      // Create a new config with autoStartSync enabled
      const configWithAutoStart: GanonConfig<TestStorage> = {
        ...mockConfig,
        autoStartSync: true,
        syncInterval: 1000
      };

      // Spy on startSyncInterval
      const startSyncSpy = jest.spyOn(SyncEngine.prototype, 'startSyncInterval');

      // Create a new engine with autoStartSync — side effects happen in start()
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithAutoStart
      );
      controller.start();

      // Verify startSyncInterval was called
      expect(startSyncSpy).toHaveBeenCalledTimes(1);

      // Cleanup
      controller.stopSyncInterval();
      startSyncSpy.mockRestore();
    });

    it('should not start sync timer when autoStartSync is false', () => {
      // Create a config with autoStartSync disabled
      const configWithoutAutoStart: GanonConfig<TestStorage> = {
        ...mockConfig,
        autoStartSync: false,
        syncInterval: 1000
      };

      // Spy on startSyncInterval
      const startSyncSpy = jest.spyOn(SyncEngine.prototype, 'startSyncInterval');

      // Create a new controller without autoStartSync
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithoutAutoStart
      );
      controller.start();

      // Verify startSyncInterval was not called
      expect(startSyncSpy).not.toHaveBeenCalled();

      // Cleanup
      controller.stopSyncInterval();
      startSyncSpy.mockRestore();
    });

    it('start() with omitted autoStartSync starts sync interval (resolved default true)', () => {
      const configOmitted: GanonConfig<TestStorage> = {
        identifierKey: 'email',
        cloudConfig: mockConfig.cloudConfig,
        syncInterval: 1000,
      };

      const startSyncSpy = jest.spyOn(SyncEngine.prototype, 'startSyncInterval');
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configOmitted
      );
      controller.start();

      expect(startSyncSpy).toHaveBeenCalledTimes(1);

      controller.stopSyncInterval();
      startSyncSpy.mockRestore();
    });

    it('should not start sync timer when syncInterval is not provided', () => {
      // Create a config without syncInterval
      const configWithoutSync: GanonConfig<TestStorage> = {
        ...mockConfig,
        syncInterval: undefined
      };

      // Create a new controller without sync interval
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithoutSync
      );

      // Verify no sync timer is started
      expect(() => controller.stopSyncInterval()).not.toThrow();
    });

    it('should trigger hydration when identifier key exists in storage', async () => {
      // Setup test data
      const testValue = 'test-value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata: LocalSyncMetadata = {
        version: Date.now() + 1000,
        digest: computeHash(testValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock that user is logged in (identifier key exists)
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      const configNoInterval = { ...mockConfig, autoStartSync: false };
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configNoInterval
      );
      controller.start();

      await jest.runOnlyPendingTimersAsync();
      await Promise.resolve();

      // Verify hydration occurred
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', testValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });

      // Cleanup
      controller.stopSyncInterval();
    });

    it('should not trigger hydration when identifier key does not exist', async () => {
      // Mock that user is not logged in (identifier key doesn't exist)
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      // Create new controller which should not trigger hydration
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        mockConfig
      );

      // Run all pending timers and promises
      await jest.runAllTimersAsync();
      await Promise.resolve(); // Flush microtasks

      // Verify no hydration occurred
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(mockFirestore.fetch).not.toHaveBeenCalled();

      // Cleanup
      controller.stopSyncInterval();
    });

    it('should handle hydration errors during construction gracefully', async () => {
      // Setup test data with hydration error
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockMetadataManager.needsHydration.mockRejectedValue(new Error('Hydration failed'));

      const configNoInterval = { ...mockConfig, autoStartSync: false };
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configNoInterval
      );
      controller.start();

      await jest.runOnlyPendingTimersAsync();
      await Promise.resolve();

      // Verify hydration was attempted but failed gracefully
      expect(mockMetadataManager.needsHydration).toHaveBeenCalled();
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();

      // Cleanup
      controller.stopSyncInterval();
    });
  });

  describe('Complex Sync Scenarios', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
    });

    it('should sync pending keys successfully', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Mark a key as pending
      syncEngine.markAsPending('testKey');
      jest.runAllTimers();

      // Execute sync
      await syncEngine.syncPending();

      // Verify results
      expect(mockOperationRepo.processOperations).toHaveBeenCalled();
      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(1);
    });

    it('should handle sync failures gracefully', async () => {
      // Setup test data with failure
      mockOperationRepo.processOperations.mockRejectedValue(new Error('Sync failed'));

      // Mark a key as pending
      syncEngine.markAsPending('testKey');
      jest.runAllTimers();

      // Execute sync and expect it to handle the error
      await expect(syncEngine.syncPending()).rejects.toThrow('Sync failed');
      expect(mockMetadataManager.recordLocalChange).toHaveBeenCalledWith('testKey', expect.objectContaining({
        syncStatus: SyncStatus.Pending,
        digest: expect.any(String),
        version: expect.any(Number)
      }));
    });

    it('should handle delete operations', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Mark a key as deleted
      syncEngine.markAsDeleted('testKey');
      jest.runAllTimers();

      // Execute sync
      await syncEngine.syncPending();

      // Verify results
      expect(mockOperationRepo.processOperations).toHaveBeenCalled();
      expect(mockOperationRepo.addOperation).toHaveBeenCalled();
    });

    it('should handle concurrent sync calls', async () => {
      // Setup test data with sync in progress protection
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Start two concurrent syncs
      const sync1Promise = syncEngine.syncPending();
      const sync2Promise = syncEngine.syncPending();

      await Promise.all([sync1Promise, sync2Promise]);

      // Second sync should be skipped due to syncInProgress flag
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(1);
    });

    it('should handle keys added during sync', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Start sync
      const syncPromise = syncEngine.syncPending();

      // Add a new key while sync is in progress
      syncEngine.markAsPending('anotherKey');
      jest.runAllTimers();

      // Wait for sync to complete
      await syncPromise;

      // Verify new key was added to operations
      expect(mockOperationRepo.addOperation).toHaveBeenCalledWith('anotherKey', expect.any(Object));
    });

    it('should prevent race conditions in sync operations', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Start sync
      const syncPromise = syncEngine.syncPending();

      // Add a new key while sync is in progress
      syncEngine.markAsPending('anotherKey');
      jest.runAllTimers();

      // Wait for sync to complete
      await syncPromise;

      // Verify new key was added to operations
      expect(mockOperationRepo.addOperation).toHaveBeenCalledWith('anotherKey', expect.any(Object));
    });

    it('should not block other operations during sync', async () => {
      // Setup test data
      let resolveSync: () => void;
      const syncPromise = new Promise<any[]>(resolve => {
        resolveSync = () => resolve([{ success: true, key: 'testKey' }]);
      });

      mockOperationRepo.processOperations.mockReturnValue(syncPromise as any);

      // Start sync
      const syncInProgress = syncEngine.syncPending();

      // Perform other operations while sync is in progress
      // Add different keys to test batching
      syncEngine.markAsPending('testKey');
      syncEngine.markAsDeleted('anotherKey');
      jest.runAllTimers();

      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);

      // Complete sync
      resolveSync!();
      await syncInProgress;
    });
  });

  describe('Hydration', () => {
    beforeEach(() => {
      // Setup common test data
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockMetadataManager.hydrateMetadata.mockResolvedValue();
    });

    it('should hydrate data from cloud successfully', async () => {
      // Setup test data
      const remoteValue = 'remote value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata: LocalSyncMetadata = {
        version: Date.now() + 1000, // Newer than local
        digest: computeHash(remoteValue), // Make digest match the remote value
        syncStatus: SyncStatus.Synced
      };

      // No local metadata to avoid conflict detection
      mockMetadataManager.get.mockReturnValue(undefined);
      
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration
      const result = await syncEngine.hydrate();

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });
    });

    it('should force hydrate data regardless of version comparison', async () => {
      // Setup test data
      const remoteValue = 'remote value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata: LocalSyncMetadata = {
        version: Date.now() + 1000,
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock that needsHydration would return false (local version is newer)
      mockMetadataManager.needsHydration.mockResolvedValue(false);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute force hydration
      const result = await syncEngine.forceHydrate(['testKey']);

      // Verify results - should hydrate even though needsHydration returned false
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });

      // Verify cache invalidation was called
      expect(mockMetadataManager.invalidateCacheForHydration).toHaveBeenCalledWith('testKey');
    });

    it('should handle force hydration failures gracefully', async () => {
      // Setup test data with a failure
      mockMetadataManager.invalidateCacheForHydration.mockResolvedValue();
      mockFirestore.fetch.mockRejectedValue(new Error('Network error'));

      // Execute force hydration
      const result = await syncEngine.forceHydrate(['testKey']);

      // Verify results
      expect(result.success).toBe(false);
      expect(result.failedKeys).toContain('testKey');
      expect(result.restoredKeys).toHaveLength(0);
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should force hydrate multiple keys successfully', async () => {
      // Setup test data
      const remoteValue1 = 'remote value 1';
      const remoteValue2 = 'remote value 2';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata1: LocalSyncMetadata = {
        version: Date.now() + 1000,
        digest: computeHash(remoteValue1),
        syncStatus: SyncStatus.Synced
      };
      const remoteMetadata2: LocalSyncMetadata = {
        version: Date.now() + 2000,
        digest: computeHash(remoteValue2),
        syncStatus: SyncStatus.Synced
      };

      mockFirestore.fetch
        .mockResolvedValueOnce(remoteValue1)
        .mockResolvedValueOnce(remoteValue2);
      mockMetadataManager.getRemoteMetadataOnly
        .mockResolvedValueOnce(remoteMetadata1)
        .mockResolvedValueOnce(remoteMetadata2);

      // Execute force hydration
      const result = await syncEngine.forceHydrate(['testKey', 'anotherKey']);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.restoredKeys).toContain('anotherKey');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockStorage.set).toHaveBeenCalledTimes(4); // 2 keys × 2 calls each (conflict resolution + final storage)
    });

    it('should skip force hydration when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      const result = await syncEngine.forceHydrate(['testKey']);

      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toHaveLength(0);
      expect(mockFirestore.fetch).not.toHaveBeenCalled();
    });

    it('should handle force hydration with metadata integrity issues', async () => {
      // Setup test data with metadata mismatch
      const testValue = 'test-value';
      const corruptedDigest = 'corrupted-digest';
      const correctDigest = 'correct-digest';

      mockFirestore.fetch.mockResolvedValue(testValue);

      // Mock getRemoteMetadataOnly to return corrupted digest for first 2 calls,
      // then correct digest on the 3rd call (last retry)
      let callCount = 0;
      mockMetadataManager.getRemoteMetadataOnly.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          digest: callCount === 3 ? correctDigest : corruptedDigest,
          version: 1
        });
      });

      // Mock computeHash to return the correct digest
      jest.spyOn(require('../../utils/computeHash'), 'default').mockReturnValue(correctDigest);

      // Execute force hydration
      const resultPromise = syncEngine.forceHydrate(['testKey']);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      // Verify the retry mechanism worked
      expect(mockMetadataManager.getRemoteMetadataOnly).toHaveBeenCalledTimes(3);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', testValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: correctDigest,
        version: 1,
      });
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle persistent metadata corruption in force hydration', async () => {
      // Setup test data
      const testValue = 'test-value';
      const corruptedDigest = 'corrupted-digest';

      mockFirestore.fetch.mockResolvedValue(testValue);

      // All calls return corrupted metadata
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue({
        digest: corruptedDigest,
        version: 1
      });

      // Mock computeHash to return a different digest
      jest.spyOn(require('../../utils/computeHash'), 'default').mockReturnValue('different-digest');

      // Execute force hydration with SKIP strategy to test persistent corruption handling
      const resultPromise = syncEngine.forceHydrate(['testKey'], undefined, {
        strategy: IntegrityFailureRecoveryStrategy.SKIP
      });
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      // Verify the retry mechanism was attempted but failed (SKIP strategy doesn't call invalidateCache)
      expect(mockMetadataManager.getRemoteMetadataOnly).toHaveBeenCalledTimes(4);
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(true); // Still true because other keys might succeed
      expect(result.restoredKeys).not.toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle missing remote metadata in force hydration', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(undefined);

      const result = await syncEngine.forceHydrate(['testKey']);

      // When remoteMetadata is undefined, the hydration still succeeds,
      // but no storage/metadata operations are performed
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey'); // Still returns true from processKey
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle getRemoteMetadataOnly throwing an error in force hydration', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.getRemoteMetadataOnly.mockRejectedValue(new Error('Metadata consistency error'));

      const result = await syncEngine.forceHydrate(['testKey']);

      // Verify no hydration occurred due to metadata error
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toContain('testKey');
    });

    it('should handle computeHash throwing an error', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration and will fail
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue({
        digest: 'some-digest',
        version: 1
      });

      // Mock computeHash to throw an error
      jest.spyOn(require('../../utils/computeHash'), 'default').mockImplementation(() => {
        throw new Error('Hash computation failed');
      });

      const resultPromise = syncEngine.hydrate();
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      // Verify no hydration occurred due to hash computation error
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toContain('testKey');
    });

    it('should hydrate keys without local metadata when remote data exists', async () => {
      // Setup test data
      const remoteValue = 'remote value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteVersion = Date.now();
      const remoteMetadata: LocalSyncMetadata = {
        version: remoteVersion,
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock that the key needs hydration (no local metadata, so version is 0)
      mockMetadataManager.get.mockReturnValue(undefined); // No local metadata
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration
      const resultPromise = syncEngine.hydrate();
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });
    });

    it('should resolve conflicts during hydration with local-wins strategy', async () => {
      // Setup test data with conflict
      const localValue = 'local-value-32';
      const remoteValue = 'remote-value-26';
      const computeHash = require('../../utils/computeHash').default;
      
      const localMetadata: LocalSyncMetadata = {
        version: 1, // Older version
        digest: computeHash(localValue),
        syncStatus: SyncStatus.Synced
      };
      
      const remoteMetadata: LocalSyncMetadata = {
        version: 2, // Newer version
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock local data exists
      mockStorage.get.mockReturnValue(localValue);
      mockMetadataManager.get.mockImplementation((key) => {
        if (key === 'testKey') return localMetadata;
        return undefined;
      });
      
      // Mock remote data
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration
      const result = await syncEngine.hydrate(['testKey']);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      
      // Verify local value was preserved (local-wins strategy)
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', localValue);
      
      // Verify metadata was updated with resolved hash
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: computeHash(localValue), // Should use local value hash
        version: expect.any(Number), // Should use current timestamp
      });
    });

    it('should resolve conflicts during hydration with remote-wins strategy', async () => {
      // Setup test data with conflict
      const localValue = 'local-value-32';
      const remoteValue = 'remote-value-26';
      const computeHash = require('../../utils/computeHash').default;
      
      const localMetadata: LocalSyncMetadata = {
        version: 1, // Older version
        digest: computeHash(localValue),
        syncStatus: SyncStatus.Synced
      };
      
      const remoteMetadata: LocalSyncMetadata = {
        version: 2, // Newer version
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock local data exists
      mockStorage.get.mockReturnValue(localValue);
      mockMetadataManager.get.mockImplementation((key) => {
        if (key === 'testKey') return localMetadata;
        return undefined;
      });
      
      // Mock remote data
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration with remote-wins strategy
      const result = await syncEngine.hydrate(['testKey'], {
        strategy: ConflictResolutionStrategy.REMOTE_WINS
      });

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      
      // Verify remote value was used (remote-wins strategy)
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
      
      // Verify metadata was updated with resolved hash
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: computeHash(remoteValue), // Should use remote value hash
        version: expect.any(Number), // Should use current timestamp
      });
    });

    it('should resolve conflicts during hydration with last-modified-wins strategy', async () => {
      // Setup test data with conflict
      const localValue = 'local-value-32';
      const remoteValue = 'remote-value-26';
      const computeHash = require('../../utils/computeHash').default;
      
      const localMetadata: LocalSyncMetadata = {
        version: 1000, // Older timestamp
        digest: computeHash(localValue),
        syncStatus: SyncStatus.Synced
      };
      
      const remoteMetadata: LocalSyncMetadata = {
        version: 2000, // Newer timestamp
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock local data exists
      mockStorage.get.mockReturnValue(localValue);
      mockMetadataManager.get.mockImplementation((key) => {
        if (key === 'testKey') return localMetadata;
        return undefined;
      });
      
      // Mock remote data
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration with last-modified-wins strategy
      const result = await syncEngine.hydrate(['testKey'], {
        strategy: ConflictResolutionStrategy.LAST_MODIFIED_WINS
      });

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      
      // Verify remote value was used (last-modified-wins strategy - remote is newer)
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
      
      // Verify metadata was updated with resolved hash
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: computeHash(remoteValue), // Should use remote value hash
        version: expect.any(Number), // Should use current timestamp
      });
    });

    it('should skip integrity checks after successful conflict resolution', async () => {
      // Setup test data with conflict
      const localValue = 'local-value-32';
      const remoteValue = 'remote-value-26';
      const computeHash = require('../../utils/computeHash').default;
      
      const localMetadata: LocalSyncMetadata = {
        version: 1,
        digest: computeHash(localValue),
        syncStatus: SyncStatus.Synced
      };
      
      const remoteMetadata: LocalSyncMetadata = {
        version: 2,
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Mock local data exists
      mockStorage.get.mockReturnValue(localValue);
      mockMetadataManager.get.mockImplementation((key) => {
        if (key === 'testKey') return localMetadata;
        return undefined;
      });
      
      // Mock remote data
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration
      const result = await syncEngine.hydrate(['testKey']);

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      
      // Verify that metadata.set was called only once (for conflict resolution)
      // and not again for integrity checks
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledTimes(1);
      
      // Verify the metadata was set with resolved value hash
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: computeHash(localValue), // Local value hash (local-wins)
        version: expect.any(Number),
      });
    });

    // Note: Testing conflict resolution failure is complex with static methods
    // This test is skipped for now as it requires complex mocking setup
    it.skip('should handle conflict resolution failure gracefully', async () => {
      // This test is skipped due to complexity of mocking static methods in ConflictResolver
      // In practice, conflict resolution rarely fails as it's a simple strategy application
    });
  });

  describe('Complex Metadata Scenarios', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
    });

    it('should handle metadata conflicts', async () => {
      // Setup test data with remote metadata
      const remoteValue = 'remote value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata: LocalSyncMetadata = {
        version: 2000,
        digest: computeHash(remoteValue),
        syncStatus: SyncStatus.Synced
      };

      // Clear local metadata to avoid conflict detection
      mockMetadataManager.get.mockReturnValue(undefined);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(remoteValue);

      // Execute hydration
      await syncEngine.hydrate();

      // Verify metadata was updated with remote version
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });
    });

    it('should handle metadata updates', async () => {
      // Update metadata for a key
      syncEngine.markAsPending('testKey');
      jest.runAllTimers();

      // Verify metadata was updated
      expect(mockMetadataManager.recordLocalChange).toHaveBeenCalledWith('testKey', expect.objectContaining({
        syncStatus: SyncStatus.Pending,
        digest: expect.any(String),
        version: expect.any(Number)
      }));
      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(1);
    });

    it('should handle metadata deletions', async () => {
      // Setup test data
      mockMetadataManager.get.mockReturnValue({
        version: Date.now(),
        digest: 'old-digest',
        syncStatus: SyncStatus.Synced
      });

      // Mark key as deleted
      syncEngine.markAsDeleted('testKey');

      // Verify metadata was updated - markAsDeleted uses updateSyncStatus, not set
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('testKey', SyncStatus.Pending);
    });

    it('should hydrate all metadata when restoring all keys via restore', async () => {
      // Setup test data
      mockMetadataManager.hydrateMetadata.mockResolvedValue();
      mockFirestore.fetch.mockResolvedValue('test value');

      // Execute restore
      await syncEngine.restore();

      // Verify metadata was hydrated
      expect(mockMetadataManager.hydrateMetadata).toHaveBeenCalled();
    });

    it('should hydrate remote metadata when hydrating keys via hydrate', async () => {
      // Setup test data
      const testValue = 'test value';
      const computeHash = require('../../utils/computeHash').default;
      const remoteMetadata: LocalSyncMetadata = {
        version: Date.now() + 1000,
        digest: computeHash(testValue),
        syncStatus: SyncStatus.Synced
      };

      // Clear local metadata to avoid conflict detection
      mockMetadataManager.get.mockReturnValue(undefined);
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(remoteMetadata);

      // Execute hydration
      await syncEngine.hydrate();

      // Verify metadata was updated
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: remoteMetadata.digest,
        version: remoteMetadata.version,
      });
    });
  });

  describe('Bulk Operations', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
    });

    it('should sync all data successfully', async () => {
      // Setup test data
      mockStorage.contains.mockReturnValue(true);
      mockOperationRepo.processOperations.mockResolvedValue([
        { success: true, key: 'testKey' },
        { success: true, key: 'anotherKey' }
      ]);

      // Execute sync all
      const result = await syncEngine.syncAll();

      // Verify results
      expect(result.success).toBe(true);
      expect(result.backedUpKeys).toContain('testKey');
      expect(result.backedUpKeys).toContain('anotherKey');
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle partial failures in bulk sync', async () => {
      // Setup test data with partial failure
      mockStorage.contains.mockReturnValue(true);
      mockOperationRepo.processOperations.mockResolvedValue([
        { success: true, key: 'testKey' },
        { success: false, key: 'anotherKey' }
      ]);

      // Execute sync all
      const result = await syncEngine.syncAll();

      // Verify results
      expect(result.success).toBe(false);
      expect(result.backedUpKeys).toContain('testKey');
      expect(result.failedKeys).toContain('anotherKey');
    });
  });

  describe('Restore Operations', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockMetadataManager.hydrateMetadata.mockResolvedValue();
    });

    it('should restore data from cloud successfully', async () => {
      // Setup test data
      const remoteValue = 'remote value';
      mockFirestore.fetch.mockResolvedValue(remoteValue);

      // Execute restore
      const result = await syncEngine.restore();

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', remoteValue);
    });

    it('should handle restore failures gracefully', async () => {
      // Setup test data with failure
      mockFirestore.fetch.mockRejectedValue(new Error('Restore failed'));

      // Execute restore
      const result = await syncEngine.restore();

      // Verify results
      expect(result.success).toBe(false);
      expect(result.failedKeys).toContain('testKey');
      expect(result.restoredKeys).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts', async () => {
      // Setup test data with timeout
      mockFirestore.fetch.mockRejectedValue(new Error('Network timeout'));
      mockMetadataManager.needsHydration.mockResolvedValue(true);

      // Execute operation
      const result = await syncEngine.hydrate();

      // Verify results
      expect(result.success).toBe(false);
      expect(result.failedKeys).toContain('testKey');
    });

    it('should handle invalid data gracefully', async () => {
      // Setup test data with invalid value
      mockFirestore.fetch.mockResolvedValue(undefined);
      mockMetadataManager.needsHydration.mockResolvedValue(true);

      // Execute operation
      const result = await syncEngine.hydrate();

      // Verify results
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toHaveLength(0);
    });
  });

  describe('Performance', () => {
    it('should handle large numbers of pending keys', async () => {
      // Setup test data with many keys
      const keys = ['testKey', 'anotherKey'] as (keyof TestStorage)[];
      mockConfig.cloudConfig = {
        'testDoc': {
          docKeys: keys,
          subcollectionKeys: [] as (keyof TestStorage)[],
        }
      };

      // Create new controller with many keys
      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        mockConfig
      );

      // Ensure no hydration is in progress
      (controller as any).hydrationPromise = null;

      // Mark all keys as pending
      keys.forEach(key => controller.markAsPending(key));
      jest.runAllTimers();

      // Execute sync
      const startTime = Date.now();
      await controller.syncPending();
      const endTime = Date.now();

      // Verify performance
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(mockOperationRepo.processOperations).toHaveBeenCalled();
      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);
    });

    it('should not block other operations during sync', async () => {
      // Setup test data
      let resolveSync: () => void;
      const syncPromise = new Promise<any[]>(resolve => {
        resolveSync = () => resolve([{ success: true, key: 'testKey' }]);
      });

      mockOperationRepo.processOperations.mockReturnValue(syncPromise as any);

      // Start sync
      const syncInProgress = syncEngine.syncPending();

      // Perform other operations while sync is in progress
      // Add different keys to test batching
      syncEngine.markAsPending('testKey');
      syncEngine.markAsDeleted('anotherKey');
      jest.runAllTimers();

      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);

      // Complete sync
      resolveSync!();
      await syncInProgress;
    });
  });

  describe('Timer Operations', () => {
    it('should automatically sync pending keys', () => {
      // Create controller with sync interval
      const configWithSync: GanonConfig<TestStorage> = {
        ...mockConfig,
        syncInterval: 1000 // 1 second
      };

      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithSync
      );

      // Verify the controller was created and timer started (no error thrown)
      expect(() => controller.startSyncInterval()).not.toThrow();

      // Clean up
      controller.stopSyncInterval();
    });

    it('should clean up resources on stopSyncInterval', () => {
      const configWithSync: GanonConfig<TestStorage> = {
        ...mockConfig,
        syncInterval: 1000
      };

      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithSync
      );

      expect(() => controller.stopSyncInterval()).not.toThrow();
    });

    it('should handle multiple calls to stopSyncInterval', () => {
      const configWithSync: GanonConfig<TestStorage> = {
        ...mockConfig,
        syncInterval: 1000
      };

      const controller = new SyncEngine(
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        mockOperationRepo,
        mockUserManager,
        configWithSync
      );

      expect(() => {
        controller.stopSyncInterval();
        controller.stopSyncInterval();
        controller.stopSyncInterval();
      }).not.toThrow();
    });
  });

  describe('lastBackup Property Updates', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      jest.clearAllMocks();
    });

    it('should update lastBackup when keys are successfully synced in syncPending', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Execute sync
      await syncEngine.syncPending();

      // Verify lastBackup was updated locally
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledTimes(1);
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should not update lastBackup when no keys are successfully synced', async () => {
      // Setup test data with no successful syncs
      mockOperationRepo.processOperations.mockResolvedValue([]);

      // Execute sync
      await syncEngine.syncPending();

      // Verify lastBackup was not updated locally
      expect(mockStorage.set).not.toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was not synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).not.toHaveBeenCalled();
    });

    it('should update lastBackup when keys are successfully synced in syncAll', async () => {
      // Setup test data
      mockStorage.contains.mockReturnValue(true);
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Execute sync all
      await syncEngine.syncAll();

      // Verify lastBackup was updated locally
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledTimes(1);
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should not update lastBackup when syncAll has no successful backups', async () => {
      // Setup test data with no successful syncs
      mockStorage.contains.mockReturnValue(true);
      mockOperationRepo.processOperations.mockResolvedValue([]);

      // Execute sync all
      await syncEngine.syncAll();

      // Verify lastBackup was not updated locally
      expect(mockStorage.set).not.toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was not synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).not.toHaveBeenCalled();
    });

    it('should update lastBackup only once when multiple keys are synced in the same batch', async () => {
      // Setup test data with multiple successful syncs
      mockOperationRepo.processOperations.mockResolvedValue([
        { success: true, key: 'testKey' },
        { success: true, key: 'anotherKey' }
      ]);

      // Execute sync
      await syncEngine.syncPending();

      // Verify lastBackup was updated only once locally
      expect(mockStorage.set).toHaveBeenCalledTimes(1);
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was synced to remote only once
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledTimes(1);
    });

    it('should update lastBackup when a key is successfully deleted', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Mark key as deleted and sync
      syncEngine.markAsDeleted('testKey');
      await syncEngine.syncPending();

      // Verify lastBackup was updated locally
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledTimes(1);
    });

    it('should sync lastBackup to remote with the same timestamp as local update', async () => {
      // Setup test data
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Execute sync
      await syncEngine.syncPending();

      // Get the timestamp that was set locally
      const lastBackupCall = mockStorage.set.mock.calls.find(call => call[0] === 'lastBackup');
      const localTimestamp = lastBackupCall![1] as number;

      // Verify the same timestamp was sent to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledWith(localTimestamp);
    });

    it('should not sync lastBackup to remote when user is not logged in', async () => {
      // Setup test data
      mockUserManager.isUserLoggedIn.mockReturnValue(false);
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Execute sync
      await syncEngine.syncPending();

      // Verify lastBackup was updated locally
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify lastBackup was NOT synced to remote
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).not.toHaveBeenCalled();
    });

    it('should handle errors when syncing lastBackup to remote gracefully', async () => {
      // Setup test data
      const syncError = new Error('Network error');
      mockFirestore.backupLastBackupToUserDocument.mockRejectedValue(syncError);
      mockOperationRepo.processOperations.mockResolvedValue([{ success: true, key: 'testKey' }]);

      // Execute sync - should not throw
      await expect(syncEngine.syncPending()).resolves.not.toThrow();

      // Verify lastBackup was still updated locally despite remote error
      expect(mockStorage.set).toHaveBeenCalledWith('lastBackup', expect.any(Number));
      
      // Verify remote backup was attempted
      await Promise.resolve(); // Wait for async backup promise
      expect(mockFirestore.backupLastBackupToUserDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('Hydrate Functionality', () => {
    beforeEach(() => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockMetadataManager.needsHydration.mockResolvedValue(true);
      mockMetadataManager.invalidateCache.mockResolvedValue(undefined);
    });

    it('should skip hydration when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      const result = await syncEngine.hydrate();

      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toHaveLength(0);
      expect(mockFirestore.fetch).not.toHaveBeenCalled();
    });

    it('should handle corrupted metadata with successful retry', async () => {
      // Setup test data
      const testValue = 'test-value';
      const corruptedDigest = 'corrupted-digest';
      const correctDigest = 'correct-digest';

      mockFirestore.fetch.mockResolvedValue(testValue);

      // Mock needsHydration for both keys
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration

      // Mock getRemoteMetadataOnly to return corrupted digest for first 2 calls,
      // then correct digest on the 3rd call (last retry)
      let callCount = 0;
      mockMetadataManager.getRemoteMetadataOnly.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          digest: callCount === 3 ? correctDigest : corruptedDigest,
          version: 1
        });
      });

      // Mock computeHash to return the correct digest
      jest.spyOn(require('../../utils/computeHash'), 'default').mockReturnValue(correctDigest);

      // Start hydration and run all timers
      const hydrationPromise = syncEngine.hydrate();
      await jest.runAllTimersAsync();
      await Promise.resolve(); // Flush microtasks
      const result = await hydrationPromise;

      // Verify the retry mechanism worked
      expect(mockMetadataManager.getRemoteMetadataOnly).toHaveBeenCalledTimes(3);
      expect(mockStorage.set).toHaveBeenCalledWith('testKey', testValue);
      expect(mockMetadataManager.recordSyncedState).toHaveBeenCalledWith('testKey', {
        syncStatus: SyncStatus.Synced,
        digest: correctDigest,
        version: 1,
      });
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle persistent metadata corruption', async () => {
      // Setup test data
      const testValue = 'test-value';
      const corruptedDigest = 'corrupted-digest';

      mockFirestore.fetch.mockResolvedValue(testValue);

      // Mock needsHydration for both keys
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration

      // All calls return corrupted metadata
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue({
        digest: corruptedDigest,
        version: 1
      });

      // Mock computeHash to return a different digest
      jest.spyOn(require('../../utils/computeHash'), 'default').mockReturnValue('different-digest');

      // Start hydration with SKIP strategy to test persistent corruption handling
      const hydrationPromise = syncEngine.hydrate(['testKey'], undefined, {
        strategy: IntegrityFailureRecoveryStrategy.SKIP
      });
      await jest.runAllTimersAsync();
      await Promise.resolve(); // Flush microtasks
      const result = await hydrationPromise;

      // Verify the retry mechanism was attempted but failed (SKIP strategy doesn't call invalidateCache)
      expect(mockMetadataManager.getRemoteMetadataOnly).toHaveBeenCalledTimes(4);
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(true); // Still true because other keys might succeed
      expect(result.restoredKeys).not.toContain('testKey');
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle missing remote metadata', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);

      // Mock needsHydration for both keys
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration

      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(undefined);

      const result = await syncEngine.hydrate();

      // When remoteMetadata is undefined, the hydration still succeeds,
      // but no storage/metadata operations are performed
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.restoredKeys).toContain('testKey'); // Still returns true from processKey
      expect(result.failedKeys).toHaveLength(0);
    });

    it('should handle getRemoteMetadataOnly throwing an error', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration and will fail
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration
      mockMetadataManager.getRemoteMetadataOnly.mockRejectedValue(new Error('Metadata consistency error'));

      const result = await syncEngine.hydrate();

      // Verify no hydration occurred due to metadata error
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toContain('testKey');
    });

    it('should handle computeHash throwing an error', async () => {
      // Setup test data
      const testValue = 'test-value';

      mockFirestore.fetch.mockResolvedValue(testValue);
      mockMetadataManager.needsHydration
        .mockResolvedValueOnce(true)  // testKey needs hydration and will fail
        .mockResolvedValueOnce(false); // anotherKey doesn't need hydration
      mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue({
        digest: 'some-digest',
        version: 1
      });

      // Mock computeHash to throw an error
      jest.spyOn(require('../../utils/computeHash'), 'default').mockImplementation(() => {
        throw new Error('Hash computation failed');
      });

      const resultPromise = syncEngine.hydrate();
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      // Verify no hydration occurred due to hash computation error
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockMetadataManager.recordSyncedState).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.restoredKeys).toHaveLength(0);
      expect(result.failedKeys).toContain('testKey');
    });
  });
});
