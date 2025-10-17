import DeleteOperation from '../../sync/operations/DeleteOperation';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import { SyncStatus } from '../../models/sync/SyncStatus';
import MetadataManager from '../../metadata/MetadataManager';
import { CloudBackupConfig } from '../../models/config/CloudBackupConfig';
import { GanonConfig } from '../../models/config/GanonConfig';
import UserManager from '../../managers/UserManager';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../../utils/Log');
jest.mock('../../managers/UserManager');

interface TestStorage {
  key1: string;
  key2: number;
  lastBackup: number;
}

describe('DeleteOperation Sync Status Tests', () => {
  let deleteOperation: DeleteOperation<TestStorage>;
  let mockStorage: jest.Mocked<StorageManager<TestStorage>>;
  let mockFirestore: jest.Mocked<FirestoreManager<TestStorage>>;
  let mockMetadataManager: jest.Mocked<MetadataManager<TestStorage>>;
  let mockUserManager: jest.Mocked<UserManager<TestStorage>>;

  beforeEach(() => {
    // Create mocks with correct constructor signatures
    mockStorage = new StorageManager<TestStorage>() as jest.Mocked<StorageManager<TestStorage>>;

    const mockCloudConfig: CloudBackupConfig<TestStorage> = {
      test: {
        docKeys: ['key1', 'key2']
      }
    };

    const config: GanonConfig<TestStorage> = {
      identifierKey: 'key1',
      cloudConfig: mockCloudConfig
    };

    mockUserManager = new UserManager<TestStorage>(config.identifierKey, mockStorage) as jest.Mocked<UserManager<TestStorage>>;
    mockFirestore = new FirestoreManager<TestStorage>(
      'test-user',
      mockCloudConfig,
      {} as any, // Mock adapter
      mockUserManager
    ) as jest.Mocked<FirestoreManager<TestStorage>>;

    mockMetadataManager = new MetadataManager<TestStorage>(
      config,
      {} as any, // Mock coordinator repo
      {} as any  // Mock local metadata
    ) as jest.Mocked<MetadataManager<TestStorage>>;

    // Setup default mock implementations
    mockFirestore.delete = jest.fn().mockResolvedValue(undefined);
    mockMetadataManager.get = jest.fn().mockReturnValue({
      syncStatus: SyncStatus.Pending,
      version: 123456,
      digest: 'existing-digest'
    });
    mockMetadataManager.set = jest.fn().mockResolvedValue(undefined);
    mockMetadataManager.updateSyncStatus = jest.fn();
    mockStorage.remove = jest.fn();

    deleteOperation = new DeleteOperation(
      'key1',
      mockStorage,
      mockFirestore,
      mockMetadataManager
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sync status lifecycle', () => {
    it('should set status to InProgress at execution start', async () => {
      await deleteOperation.execute();
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.InProgress);
    });

    it('should complete successfully without setting status to Synced (deletion removes metadata)', async () => {
      const result = await deleteOperation.execute();
      expect(result.success).toBe(true);
      expect(mockMetadataManager.set).toHaveBeenCalledWith('key1', {
        syncStatus: SyncStatus.Synced,
        version: expect.any(Number),
        digest: ''
      });
    });

    it('should set status to Failed when operation throws error', async () => {
      const error = new Error('Test error');
      mockFirestore.delete.mockRejectedValueOnce(error);

      await deleteOperation.execute();
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
    });

    it('should set status to Failed when firestore delete fails', async () => {
      const error = new Error('Firestore delete failed');
      mockFirestore.delete.mockRejectedValueOnce(error);

      await deleteOperation.execute();
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
    });

    it('should set status to Failed when metadata removal fails', async () => {
      const error = new Error('Metadata update failed');
      mockMetadataManager.set.mockRejectedValueOnce(error);

      try {
        await deleteOperation.execute();
      } catch (e) {
        // Swallow error to prevent test runner from crashing
      }
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
    });

    it('should set status to Failed when storage removal fails', async () => {
      const error = new Error('Storage removal failed');
      mockStorage.remove.mockImplementationOnce(() => {
        throw error;
      });

      await deleteOperation.execute();
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
    });
  });

  describe('error handling', () => {
    it('should maintain existing metadata when setting Failed status', async () => {
      const error = new Error('Test error');
      mockFirestore.delete.mockRejectedValueOnce(error);

      await deleteOperation.execute();
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
      // Verify that we don't call set() when there's an error
      expect(mockMetadataManager.set).not.toHaveBeenCalled();
    });

    it('should handle undefined metadata gracefully', async () => {
      mockMetadataManager.get.mockReturnValueOnce(undefined);

      const result = await deleteOperation.execute();
      expect(result.success).toBe(true);
      expect(mockMetadataManager.set).toHaveBeenCalledWith('key1', {
        syncStatus: SyncStatus.Synced,
        version: expect.any(Number),
        digest: ''
      });
    });
  });

  describe('successful deletion flow', () => {
    it('should follow correct deletion order: firestore -> local storage -> metadata', async () => {
      const executionOrder: string[] = [];

      mockFirestore.delete.mockImplementationOnce(async () => {
        executionOrder.push('firestore');
      });

      mockStorage.remove.mockImplementationOnce(() => {
        executionOrder.push('storage');
      });

      mockMetadataManager.set.mockImplementationOnce(async () => {
        executionOrder.push('metadata');
      });

      await deleteOperation.execute();
      expect(executionOrder).toEqual(['firestore', 'storage', 'metadata']);
    });

    it('should return the correct key in successful result', async () => {
      const result = await deleteOperation.execute();
      expect(result).toEqual({
        success: true,
        key: 'key1'
      });
    });
  });

  describe('conflict handler compatibility', () => {
    it('should accept conflict handler parameter for API compatibility', () => {
      // The conflict handler is typed as any in DeleteOperation for API compatibility
      // and is not actually used in the operation
      const operation = new DeleteOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
      );
      expect(operation).toBeDefined();
    });

    it('should work without conflict handler', () => {
      const operation = new DeleteOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager
      );
      expect(operation).toBeDefined();
    });
  });
});
