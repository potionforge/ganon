import SyncController from '../../sync/SyncController';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import OperationRepo from '../../sync/OperationRepo';
import { GanonConfig } from '../../models/config/GanonConfig';
import NetworkMonitor from '../../utils/NetworkMonitor';
import { SyncStatus } from '../../models/sync/SyncStatus';
import MetadataManager from '../../metadata/MetadataManager';
import LocalSyncMetadata from '../../models/sync/LocalSyncMetadata';
import MetadataCoordinatorRepo from '../../metadata/MetadataCoordinatorRepo';
import LocalMetadataManager from '../../metadata/local/LocalMetadataManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import UserManager from '../../managers/UserManager';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../../sync/OperationRepo');
jest.mock('../../utils/Log');
jest.mock('../../utils/NetworkMonitor');
jest.mock('../../firestore/FirestoreAdapter');
jest.mock('../../firestore/ref/FirestoreReferenceManager');
jest.mock('../../managers/UserManager');

interface TestStorage {
  email: string;
  key1: string;
  key2: number;
  key3: boolean;
  lastBackup: number;
}

describe('SyncController Sync Status Tests', () => {
  let syncController: SyncController<TestStorage>;
  let storageManager: jest.Mocked<StorageManager<TestStorage>>;
  let firestoreManager: jest.Mocked<FirestoreManager<TestStorage>>;
  let metadataManager: jest.Mocked<MetadataManager<TestStorage>>;
  let operationRepo: jest.Mocked<OperationRepo<TestStorage>>;
  let config: GanonConfig<TestStorage>;
  let adapter: jest.Mocked<FirestoreAdapter<TestStorage>>;
  let referenceManager: jest.Mocked<FirestoreReferenceManager<TestStorage>>;
  let mockUserManager: jest.Mocked<UserManager<TestStorage>>;

  beforeEach(() => {
    jest.useFakeTimers();
    // Reset all mocks
    jest.clearAllMocks();

    // Setup config with required properties first
    config = {
      identifierKey: 'key1',
      cloudConfig: {
        test: {
          docKeys: ['key1', 'key2', 'key3'],
          type: 'object'
        }
      }
    };

    // Then create other mocks that depend on config
    storageManager = new StorageManager<TestStorage>() as jest.Mocked<StorageManager<TestStorage>>;
    adapter = new FirestoreAdapter(config) as jest.Mocked<FirestoreAdapter<TestStorage>>;
    mockUserManager = new UserManager<TestStorage>(config.identifierKey, storageManager) as jest.Mocked<UserManager<TestStorage>>;

    // Initialize FirestoreManager with required arguments
    firestoreManager = new FirestoreManager<TestStorage>(
      config.identifierKey,
      config.cloudConfig,
      adapter,
      mockUserManager
    ) as jest.Mocked<FirestoreManager<TestStorage>>;

    // Ensure cloudConfig is set on the mock
    firestoreManager.cloudConfig = config.cloudConfig;

    // Initialize FirestoreReferenceManager
    referenceManager = new FirestoreReferenceManager<TestStorage>(
      mockUserManager,
      config.cloudConfig
    ) as jest.Mocked<FirestoreReferenceManager<TestStorage>>;

    // Initialize LocalMetadataManager
    const localMetadata = new LocalMetadataManager<TestStorage>(storageManager) as jest.Mocked<LocalMetadataManager<TestStorage>>;

    // Initialize MetadataCoordinatorRepo
    const coordinatorRepo = new MetadataCoordinatorRepo<TestStorage>(
      config.cloudConfig,
      adapter,
      referenceManager,
      localMetadata,
      mockUserManager
    ) as jest.Mocked<MetadataCoordinatorRepo<TestStorage>>;

    // Initialize MetadataManager
    metadataManager = new MetadataManager<TestStorage>(
      config,
      coordinatorRepo,
      localMetadata
    ) as jest.Mocked<MetadataManager<TestStorage>>;
    
    // Mock the set method to return a resolved promise
    metadataManager.set = jest.fn().mockResolvedValue(undefined);

    // Initialize OperationRepo
    const networkMonitor = new NetworkMonitor();
    operationRepo = new OperationRepo<TestStorage>(networkMonitor) as jest.Mocked<OperationRepo<TestStorage>>;

    // Create SyncController instance
    syncController = new SyncController(
      storageManager,
      firestoreManager,
      metadataManager,
      operationRepo,
      mockUserManager,
      config
    );
  });

  // Helper function to create metadata with required properties
  const createMetadata = (syncStatus: SyncStatus): LocalSyncMetadata => ({
    syncStatus,
    digest: 'test-digest',
    version: 1
  });

  describe('markAsPending', () => {
    it('should set sync status to Pending when operation is queued', () => {
      // Arrange
      const key = 'key1';
      const testValue = 'test-value';
      storageManager.get.mockReturnValue(testValue);
      // Mock existing metadata with different digest to trigger operation creation
      metadataManager.get.mockReturnValue({
        syncStatus: SyncStatus.Synced,
        digest: 'old-digest',
        version: 1
      });

      // Act
      syncController.markAsPending(key);
      jest.runAllTimers();

      // Assert
      expect(metadataManager.set).toHaveBeenCalledWith(key, expect.objectContaining({
        syncStatus: SyncStatus.Pending,
        digest: expect.any(String),
        version: expect.any(Number)
      }), true); // Should schedule remote sync by default
      expect(operationRepo.addOperation).toHaveBeenCalled();
    });

    it('should handle metadata with defaults when no existing metadata', () => {
      // Arrange
      const key = 'key1';
      const testValue = 'test-value';
      storageManager.get.mockReturnValue(testValue);
      metadataManager.get.mockReturnValue(undefined);

      // Act
      syncController.markAsPending(key);
      jest.runAllTimers();

      // Assert
      expect(metadataManager.set).toHaveBeenCalledWith(key, expect.objectContaining({
        syncStatus: SyncStatus.Pending,
        digest: expect.any(String),
        version: expect.any(Number)
      }), true); // Should schedule remote sync by default
      expect(operationRepo.addOperation).toHaveBeenCalled();
    });

    it('should skip operation when hash has not changed', () => {
      // Arrange
      const key = 'key1';
      const testValue = 'test-value';
      storageManager.get.mockReturnValue(testValue);
      // Mock existing metadata with same digest (computed hash would match)
      metadataManager.get.mockReturnValue({
        syncStatus: SyncStatus.Synced,
        digest: 'dcf45dbc5d40c4a8',
        version: 1
      });

      // Act
      syncController.markAsPending(key);
      jest.runAllTimers();

      // Assert
      expect(metadataManager.updateSyncStatus).not.toHaveBeenCalled();
      expect(operationRepo.addOperation).not.toHaveBeenCalled();
    });

    it('should mark as deleted when key does not exist in storage', () => {
      // Arrange
      const key = 'key1';
      storageManager.get.mockReturnValue(undefined);
      // Mock existing metadata so markAsDeleted will proceed
      metadataManager.get.mockReturnValue({
        syncStatus: SyncStatus.Synced,
        digest: 'existing-digest',
        version: 1
      });

      // Act
      syncController.markAsPending(key);
      jest.runAllTimers();

      // Assert - markAsDeleted uses updateSyncStatus, not set
      expect(metadataManager.updateSyncStatus).toHaveBeenCalledWith(key, SyncStatus.Pending);
      expect(operationRepo.addOperation).toHaveBeenCalled();
    });
  });

  describe('markAsDeleted', () => {
    it('should set sync status to Pending when delete operation is queued', () => {
      // Arrange
      const key = 'key1';
      // Mock existing metadata with valid digest to trigger delete operation
      metadataManager.get.mockReturnValue({
        syncStatus: SyncStatus.Synced,
        digest: 'existing-digest',
        version: 1
      });

      // Act
      syncController.markAsDeleted(key);

      // Assert - markAsDeleted uses updateSyncStatus, not set
      expect(metadataManager.updateSyncStatus).toHaveBeenCalledWith(key, SyncStatus.Pending);
      expect(operationRepo.addOperation).toHaveBeenCalled();
    });

    it('should skip delete operation when no metadata exists', () => {
      // Arrange
      const key = 'key1';
      metadataManager.get.mockReturnValue(undefined);

      // Act
      syncController.markAsDeleted(key);

      // Assert
      expect(metadataManager.updateSyncStatus).not.toHaveBeenCalled();
      expect(operationRepo.addOperation).not.toHaveBeenCalled();
    });

    it('should skip delete operation when digest is empty', () => {
      // Arrange
      const key = 'key1';
      metadataManager.get.mockReturnValue({
        syncStatus: SyncStatus.Synced,
        digest: '',
        version: 1
      });

      // Act
      syncController.markAsDeleted(key);

      // Assert
      expect(metadataManager.updateSyncStatus).not.toHaveBeenCalled();
      expect(operationRepo.addOperation).not.toHaveBeenCalled();
    });
  });

  describe('getSyncStatus', () => {
    it('should return the current sync status for a key', () => {
      // Arrange
      const key = 'key1';
      metadataManager.get.mockReturnValue(createMetadata(SyncStatus.Synced));

      // Act
      const status = syncController.getSyncStatus(key);

      // Assert
      expect(status).toBe(SyncStatus.Synced);
      expect(metadataManager.get).toHaveBeenCalledWith(key);
    });

    it('should return sync status for different status values', () => {
      // Arrange
      const key = 'key1';
      const statuses = [
        SyncStatus.Pending,
        SyncStatus.InProgress,
        SyncStatus.Synced,
        SyncStatus.Failed,
        SyncStatus.Conflict
      ];

      // Act & Assert
      statuses.forEach(expectedStatus => {
        metadataManager.get.mockReturnValue(createMetadata(expectedStatus));
        const status = syncController.getSyncStatus(key);
        expect(status).toBe(expectedStatus);
      });
    });
  });

  describe('getKeysByStatus', () => {
    beforeEach(() => {
      // Reset mock implementation before each test
      metadataManager.get.mockReset();
    });

    it('should return keys that have the specified sync status', () => {
      // Arrange
      metadataManager.get.mockImplementation((key) => {
        switch (key) {
          case 'key1':
            return createMetadata(SyncStatus.Pending);
          case 'key2':
            return createMetadata(SyncStatus.Synced);
          case 'key3':
            return createMetadata(SyncStatus.Pending);
          default:
            return undefined;
        }
      });

      // Act
      const pendingKeys = syncController.getKeysByStatus(SyncStatus.Pending);

      // Assert
      expect(pendingKeys).toEqual(['key1', 'key3']);
    });

    it('should return empty array when no keys have the specified status', () => {
      // Arrange
      metadataManager.get.mockImplementation((key) => {
        switch (key) {
          case 'key1':
          case 'key2':
          case 'key3':
            return createMetadata(SyncStatus.Synced);
          default:
            return undefined;
        }
      });

      // Act
      const pendingKeys = syncController.getKeysByStatus(SyncStatus.Pending);

      // Assert
      expect(pendingKeys).toEqual([]);
    });

    it('should return all keys when they all have the specified status', () => {
      // Arrange
      metadataManager.get.mockImplementation((key) => {
        switch (key) {
          case 'key1':
          case 'key2':
          case 'key3':
            return createMetadata(SyncStatus.Synced);
          default:
            return undefined;
        }
      });

      // Act
      const syncedKeys = syncController.getKeysByStatus(SyncStatus.Synced);

      // Assert
      expect(syncedKeys).toEqual(['key1', 'key2', 'key3']);
    });
  });

  describe('getSyncStatusSummary', () => {
    beforeEach(() => {
      // Reset mock implementation before each test
      metadataManager.get.mockReset();
    });

    it('should return a summary of all sync statuses', () => {
      // Arrange
      metadataManager.get.mockImplementation((key) => {
        switch (key) {
          case 'key1':
            return createMetadata(SyncStatus.Pending);
          case 'key2':
            return createMetadata(SyncStatus.InProgress);
          case 'key3':
            return createMetadata(SyncStatus.Synced);
          default:
            return undefined;
        }
      });

      // Act
      const summary = syncController.getSyncStatusSummary();

      // Assert
      expect(summary).toEqual({
        [SyncStatus.Pending]: 1,
        [SyncStatus.InProgress]: 1,
        [SyncStatus.Synced]: 1,
        [SyncStatus.Failed]: 0,
        [SyncStatus.Conflict]: 0
      });
    });

    it('should handle multiple keys with the same status', () => {
      // Arrange
      metadataManager.get.mockImplementation((key) => {
        switch (key) {
          case 'key1':
          case 'key2':
          case 'key3':
            return createMetadata(SyncStatus.Pending);
          default:
            return undefined;
        }
      });

      // Act
      const summary = syncController.getSyncStatusSummary();

      // Assert
      expect(summary[SyncStatus.Pending]).toBe(3);
    });

    it('should return all zeros when no configured keys', () => {
      // Arrange
      firestoreManager.cloudConfig = {};

      // Act
      const summary = syncController.getSyncStatusSummary();

      // Assert
      expect(summary).toEqual({
        [SyncStatus.Pending]: 0,
        [SyncStatus.InProgress]: 0,
        [SyncStatus.Synced]: 0,
        [SyncStatus.Failed]: 0,
        [SyncStatus.Conflict]: 0
      });
    });
  });

  describe('hasPendingOperations', () => {
    it('should return true when there are pending operations', () => {
      // Arrange
      metadataManager.get
        .mockReturnValueOnce(createMetadata(SyncStatus.Pending))  // key1
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced))   // key2
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced));  // key3

      // Act
      const hasPending = syncController.hasPendingOperations();

      // Assert
      expect(hasPending).toBe(true);
    });

    it('should return true when there are in-progress operations', () => {
      // Arrange
      metadataManager.get
        .mockReturnValueOnce(createMetadata(SyncStatus.InProgress)) // key1
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced))    // key2
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced));   // key3

      // Act
      const hasPending = syncController.hasPendingOperations();

      // Assert
      expect(hasPending).toBe(true);
    });

    it('should return false when all operations are synced or failed', () => {
      // Arrange
      metadataManager.get
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced))   // key1
        .mockReturnValueOnce(createMetadata(SyncStatus.Failed))   // key2
        .mockReturnValueOnce(createMetadata(SyncStatus.Synced));  // key3

      // Act
      const hasPending = syncController.hasPendingOperations();

      // Assert
      expect(hasPending).toBe(false);
    });

    it('should return false when no configured keys', () => {
      // Arrange
      firestoreManager.cloudConfig = {};

      // Act
      const hasPending = syncController.hasPendingOperations();

      // Assert
      expect(hasPending).toBe(false);
    });
  });
});
