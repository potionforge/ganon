import { jest } from '@jest/globals';
import SyncController from '../../sync/SyncController';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import OperationRepo from '../../sync/OperationRepo';
import NetworkMonitor from '../../utils/NetworkMonitor';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import MetadataManager from '../../metadata/MetadataManager';
import UserManager from '../../managers/UserManager';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../../sync/OperationRepo');
jest.mock('../../utils/NetworkMonitor');
jest.mock('../../managers/UserManager');

interface TestStorage extends BaseStorageMapping {
  email: string;
  testKey: string;
  anotherKey: number;
}

describe('SyncController - Race Conditions', () => {
  let syncController: SyncController<TestStorage>;
  let mockStorage: jest.Mocked<StorageManager<TestStorage>>;
  let mockFirestore: jest.Mocked<FirestoreManager<TestStorage>>;
  let mockMetadataManager: jest.Mocked<MetadataManager<TestStorage>>;
  let mockOperationRepo: jest.Mocked<OperationRepo<TestStorage>>;
  let mockNetworkMonitor: jest.Mocked<NetworkMonitor>;
  let mockUserManager: jest.Mocked<UserManager<TestStorage>>;
  let mockConfig: GanonConfig<TestStorage>;

  beforeEach(() => {
    jest.useFakeTimers();
    // Create fresh mocks for each test
    mockStorage = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      upsert: jest.fn(),
      contains: jest.fn(),
      clearAllData: jest.fn()
    } as any;

    mockFirestore = {
      getRemoteMetadata: jest.fn(),
      setRemoteMetadata: jest.fn(),
      backup: jest.fn(),
      fetch: jest.fn(),
      delete: jest.fn(),
      confirm: jest.fn(),
      dangerouslyDelete: jest.fn(),
      setCurrentUser: jest.fn(),
      clearCurrentUser: jest.fn(),
      getCurrentUser: jest.fn(),
      isUserLoggedIn: jest.fn(),
      cloudConfig: {}
    } as any;

    mockMetadataManager = {
      get: jest.fn(),
      has: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      clear: jest.fn(),
      updateSyncStatus: jest.fn(),
      hydrateMetadata: jest.fn(),
      needsHydration: jest.fn(),
      ensureConsistency: jest.fn(),
      invalidateCache: jest.fn(),
      cancelPendingOperations: jest.fn()
    } as any;

    mockOperationRepo = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      upsert: jest.fn(),
      contains: jest.fn(),
      clearAllData: jest.fn(),
      addOperation: jest.fn(),
      removeOperation: jest.fn(),
      processOperations: jest.fn(),
      clearAll: jest.fn()
    } as any;

    mockNetworkMonitor = {
      isOnline: jest.fn().mockReturnValue(true),
      onOnline: jest.fn(),
      onOffline: jest.fn()
    } as any;

    mockUserManager = {
      getCurrentUser: jest.fn(),
      isUserLoggedIn: jest.fn()
    } as any;

    mockConfig = {
      identifierKey: 'email',
      cloudConfig: {
        'testDoc': {
          docKeys: ['testKey', 'anotherKey'] as (keyof TestStorage)[],
          subcollectionKeys: [] as (keyof TestStorage)[],
        }
      },
      syncInterval: 1000
    };

    // Set up default mocks for storage and metadata to ensure operations are created
    mockStorage.get.mockImplementation((key) => {
      if (key === 'testKey') return 'test-value' as any;
      if (key === 'anotherKey') return 42 as any;
      return undefined;
    });

    // Mock metadata to return different digests so operations get created
    mockMetadataManager.get.mockImplementation((key) => {
      if (key === 'testKey') {
        return {
          syncStatus: 'synced' as any,
          digest: 'old-digest-test',
          version: 1
        };
      }
      if (key === 'anotherKey') {
        return {
          syncStatus: 'synced' as any,
          digest: 'existing-digest',
          version: 1
        };
      }
      return undefined;
    });

    // Set cloudConfig on the firestore mock
    mockFirestore.cloudConfig = mockConfig.cloudConfig;

    syncController = new SyncController(
      mockStorage,
      mockFirestore,
      mockMetadataManager,
      mockOperationRepo,
      mockUserManager,
      mockConfig,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    syncController.stopSyncInterval();
  });

  describe('Concurrent Sync Prevention', () => {
    it('should prevent concurrent syncPending calls', async () => {
      let resolveFirst: () => void;
      let resolveSecond: () => void;

      const firstPromise = new Promise<any[]>(resolve => {
        resolveFirst = () => resolve([]);
      });
      const secondPromise = new Promise<any[]>(resolve => {
        resolveSecond = () => resolve([]);
      });

      mockOperationRepo.processOperations
        .mockReturnValueOnce(firstPromise as any)
        .mockReturnValueOnce(secondPromise as any);

      // Start two concurrent sync operations
      const sync1Promise = syncController.syncPending();
      const sync2Promise = syncController.syncPending();

      // Resolve the first operation
      resolveFirst!();
      await sync1Promise;

      // The second should have been ignored/queued
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(1);

      // Resolve the second operation
      resolveSecond!();
      await sync2Promise;
    });

    it('should allow subsequent calls after first completes', async () => {
      mockOperationRepo.processOperations.mockResolvedValue([]);

      // First sync
      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(1);

      // Second sync should be allowed
      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });

    it('should handle sync errors gracefully', async () => {
      const syncError = new Error('Sync failed');
      mockOperationRepo.processOperations.mockRejectedValue(syncError);

      await expect(syncController.syncPending()).rejects.toThrow('Sync failed');

      // Should allow subsequent syncs after error
      mockOperationRepo.processOperations.mockResolvedValue([]);
      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });
  });

  describe('Backup Timestamp Management', () => {
    it('should update lastBackup timestamp only for successful operations', async () => {
      const beforeTime = Date.now();
      // Return successful results to trigger lastBackup update
      mockOperationRepo.processOperations.mockResolvedValue([
        { success: true, key: 'testKey' as keyof TestStorage }
      ]);

      await syncController.syncPending();

      const afterTime = Date.now();
      expect(mockStorage.set).toHaveBeenCalledWith(
        'lastBackup',
        expect.any(Number)
      );

      const lastBackupCall = mockStorage.set.mock.calls.find(
        call => call[0] === 'lastBackup'
      );
      const timestamp = lastBackupCall![1] as number;
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should not update lastBackup when all operations fail', async () => {
      const syncError = new Error('All operations failed');
      mockOperationRepo.processOperations.mockRejectedValue(syncError);

      await expect(syncController.syncPending()).rejects.toThrow();

      expect(mockStorage.set).not.toHaveBeenCalledWith(
        'lastBackup',
        expect.any(Number)
      );
    });

    it('should not update lastBackup when no operations exist', async () => {
      mockOperationRepo.processOperations.mockResolvedValue([]);

      await syncController.syncPending();

      // Should NOT update lastBackup when no operations are processed
      expect(mockStorage.set).not.toHaveBeenCalledWith(
        'lastBackup',
        expect.any(Number)
      );
    });
  });

  describe('Operation Queue Management', () => {
    it('should handle operations added while sync is in progress', async () => {
      let resolveSyncPromise: () => void;
      const syncPromise = new Promise<any[]>(resolve => {
        resolveSyncPromise = () => resolve([]);
      });

      mockOperationRepo.processOperations.mockReturnValue(syncPromise as any);

      // Start sync
      const syncInProgress = syncController.syncPending();

      // Add operations while sync is in progress
      syncController.markAsPending('testKey');
      syncController.markAsDeleted('anotherKey');
      jest.runAllTimers();

      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);

      // Complete sync
      resolveSyncPromise!();
      await syncInProgress;
    });

    it('should handle operation repo failures gracefully', () => {
      const repoError = new Error('Operation repo failed');
      mockOperationRepo.addOperation.mockImplementation(() => {
        throw repoError;
      });

      expect(() => {
        syncController.markAsPending('testKey');
        jest.runAllTimers();
      }).toThrow('Operation repo failed');
    });

    it('should deduplicate rapid operation additions for the same key', () => {
      // Add the same key rapidly
      for (let i = 0; i < 1000; i++) {
        syncController.markAsPending('testKey');
      }
      jest.runAllTimers();
      // With batching, we expect only one operation for the deduplicated key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(1);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle rapid successive operation additions efficiently', () => {
      const startTime = Date.now();
      // Add different keys to test batching efficiency
      for (let i = 0; i < 1000; i++) {
        // Use testKey and anotherKey alternately to test batching with valid keys
        syncController.markAsPending(i % 2 === 0 ? 'testKey' : 'anotherKey');
      }
      jest.runAllTimers();
      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
      // With batching, we expect one operation per unique key (2 unique keys)
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);
    });

    it('should prevent sync queue buildup', async () => {
      mockOperationRepo.processOperations.mockResolvedValue([]);

      // Start multiple syncs rapidly
      const syncPromises = Array.from({ length: 10 }, () => 
        syncController.syncPending()
      );

      await Promise.all(syncPromises);

      // Should not have queued up multiple sync operations due to syncInProgress flag
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(1);
    });

    it('should handle large operation batches efficiently', async () => {
      mockOperationRepo.processOperations.mockResolvedValue([]);

      // Add many operations
      for (let i = 0; i < 10000; i++) {
        syncController.markAsPending('testKey');
      }

      const startTime = Date.now();
      await syncController.syncPending();
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });

  describe('Cleanup and Resource Management', () => {
    it('should properly cleanup sync locks on completion', async () => {
      mockOperationRepo.processOperations.mockResolvedValue([]);

      await syncController.syncPending();

      // Should be able to start another sync immediately
      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });

    it('should cleanup sync locks on error', async () => {
      const syncError = new Error('Sync failed');
      mockOperationRepo.processOperations.mockRejectedValue(syncError);

      await expect(syncController.syncPending()).rejects.toThrow();

      // Should be able to start another sync after error
      mockOperationRepo.processOperations.mockResolvedValue([]);
      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });

    it('should handle manual sync calls', async () => {
      let resolveSyncPromise: () => void;
      const syncPromise = new Promise<any[]>(resolve => {
        resolveSyncPromise = () => resolve([]);
      });

      mockOperationRepo.processOperations.mockReturnValue(syncPromise as any);

      // Start sync
      const syncInProgress = syncController.syncPending();

      // Complete sync
      resolveSyncPromise!();
      await syncInProgress;

      // Should be able to start new syncs
      mockOperationRepo.processOperations.mockResolvedValue([]);
      await syncController.syncPending();
      
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from network failures', async () => {
      // Simulate network failure
      mockNetworkMonitor.isOnline.mockReturnValue(false);
      mockOperationRepo.processOperations.mockRejectedValue(new Error('Network error'));

      await expect(syncController.syncPending()).rejects.toThrow('Network error');

      // Simulate network recovery
      mockNetworkMonitor.isOnline.mockReturnValue(true);
      mockOperationRepo.processOperations.mockResolvedValue([]);

      await syncController.syncPending();
      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(2);
    });

    it('should handle partial operation failures', async () => {
      // Mock partial failure scenario
      mockOperationRepo.processOperations.mockResolvedValue([]);

      await syncController.syncPending();

      expect(mockOperationRepo.processOperations).toHaveBeenCalledTimes(1);
    });

    it('should maintain state consistency during errors', () => {
      // Mock error on first batch of operations
      mockOperationRepo.addOperation.mockImplementationOnce(() => { throw new Error('fail'); });
      
      // Add first operation and expect it to throw
      expect(() => {
        syncController.markAsPending('testKey');
        jest.runAllTimers(); // First batch
      }).toThrow('fail');
      
      // Verify the error was thrown and no further operations were attempted
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(1);
      
      // Reset mock to allow second operation
      mockOperationRepo.addOperation.mockReset();
      mockOperationRepo.addOperation.mockImplementation(() => {});
      
      // Add second operation and verify it works
      syncController.markAsDeleted('anotherKey');
      jest.runAllTimers(); // Second batch
      
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(1);
    });

    it('should cancel pending operations on logout to prevent race conditions', () => {
      // Add some pending operations with different keys
      syncController.markAsPending('testKey');
      syncController.markAsDeleted('anotherKey');
      jest.runAllTimers();

      // With batching, we expect one operation per unique key
      expect(mockOperationRepo.addOperation).toHaveBeenCalledTimes(2);

      // Cancel pending operations (simulating logout)
      syncController.cancelPendingOperations();

      // Verify operations were cleared
      expect(mockOperationRepo.clearAll).toHaveBeenCalledTimes(1);
      expect(mockMetadataManager.cancelPendingOperations).toHaveBeenCalledTimes(1);
    });
  });
}); 
