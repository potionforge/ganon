import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import DeleteOperation from '../../../sync/operations/DeleteOperation';
import { TestStorageMapping } from '../../../__mocks__/MockConfig';
import MetadataManager from '../../../metadata/MetadataManager';
import SyncError, { SyncErrorType } from '../../../errors/SyncError';
import { SyncStatus } from '../../../models/sync/SyncStatus';
import FirestoreManager from '../../../firestore/FirestoreManager';
import { 
  createMockStorageManager, 
  createMockFirestoreManager, 
  createMockMetadataManager 
} from '../../utils/TestSetupUtils';

// Mock Log to avoid noise in tests
jest.mock('../../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

// Extend FirestoreManager type to include test methods
interface TestFirestoreManager<T extends TestStorageMapping> extends FirestoreManager<T> {
  setDocumentData: (docName: string, key: string, data: any) => void;
}

// Extend MetadataManager type to include test methods
interface TestMetadataManager<T extends TestStorageMapping> extends MetadataManager<T> {
  has: jest.MockedFunction<(key: keyof T) => boolean>;
}

describe('DeleteOperation', () => {
  let deleteOperation: DeleteOperation<TestStorageMapping>;
  let mockStorage: ReturnType<typeof createMockStorageManager<TestStorageMapping>>;
  let mockFirestore: ReturnType<typeof createMockFirestoreManager<TestStorageMapping>> & TestFirestoreManager<TestStorageMapping>;
  let mockMetadataManager: ReturnType<typeof createMockMetadataManager<TestStorageMapping>> & TestMetadataManager<TestStorageMapping>;
  const testKey = 'user';

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mocks using utility functions
    mockStorage = createMockStorageManager<TestStorageMapping>();
    mockFirestore = createMockFirestoreManager<TestStorageMapping>() as any;
    mockMetadataManager = createMockMetadataManager<TestStorageMapping>() as any;

    // Add test-specific methods
    mockFirestore.setDocumentData = jest.fn();
    mockMetadataManager.has = jest.fn() as jest.MockedFunction<(key: keyof TestStorageMapping) => boolean>;

    deleteOperation = new DeleteOperation(
      testKey,
      mockStorage,
      mockFirestore,
      mockMetadataManager
    );
  });

  describe('Successful Execution', () => {
    it('should successfully delete key from all stores and update sync status', async () => {
      // Setup initial data
      mockStorage.contains.mockReturnValue(true);
      mockMetadataManager.has.mockReturnValue(true);

      // Execute delete operation
      const result = await deleteOperation.execute();

      // Verify successful result
      expect(result.success).toBe(true);
      expect(result.key).toBe(testKey);
      expect(result.error).toBeUndefined();
      expect(result.shouldRetry).toBeUndefined();

      // Verify sync status transitions
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.InProgress);
      expect(mockMetadataManager.set).toHaveBeenCalledWith(testKey, expect.objectContaining({
        syncStatus: SyncStatus.Synced,
        version: expect.any(Number),
        digest: ''
      }));

      // Verify all stores are cleaned up
      expect(mockStorage.remove).toHaveBeenCalledWith(testKey);
      expect(mockFirestore.delete).toHaveBeenCalledWith(testKey);
    });

    it('should handle deletion when key does not exist in some stores', async () => {
      // Setup partial data - only in metadata
      mockStorage.contains.mockReturnValue(false);
      mockMetadataManager.has.mockReturnValue(true);

      const result = await deleteOperation.execute();

      // Should still succeed
      expect(result.success).toBe(true);
      expect(result.key).toBe(testKey);

      // Verify sync status transitions
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.InProgress);
      expect(mockMetadataManager.set).toHaveBeenCalledWith(testKey, expect.objectContaining({
        syncStatus: SyncStatus.Synced,
        version: expect.any(Number),
        digest: ''
      }));

      // Verify cleanup attempts
      expect(mockStorage.remove).toHaveBeenCalledWith(testKey);
      expect(mockFirestore.delete).toHaveBeenCalledWith(testKey);
    });
  });

  describe('Error Handling', () => {
    it('should handle firestore delete failure and update sync status', async () => {
      // Setup mock to fail delete
      const error = new Error('Mock delete failure');
      mockFirestore.delete.mockRejectedValueOnce(error);

      const result = await deleteOperation.execute();

      // Verify error result
      expect(result.success).toBe(false);
      expect(result.key).toBe(testKey);
      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.error?.message).toContain('Mock delete failure');
      expect(result.shouldRetry).toBe(true);

      // Verify sync status transitions
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.InProgress);
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.Failed);
    });

    it('should convert non-SyncError to SyncError and update sync status', async () => {
      // Mock firestore to throw a regular error
      const error = new Error('Regular error');
      mockFirestore.delete.mockRejectedValueOnce(error);

      const result = await deleteOperation.execute();

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.error?.message).toContain('Operation failed: Error: Regular error');
      expect((result.error as SyncError).type).toBe(SyncErrorType.SyncFailed);

      // Verify sync status transitions
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.InProgress);
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.Failed);
    });

    it('should preserve SyncError when thrown and update sync status', async () => {
      const originalSyncError = new SyncError(
        'Test sync error',
        SyncErrorType.SyncNetworkError
      );

      mockFirestore.delete.mockRejectedValueOnce(originalSyncError);

      const result = await deleteOperation.execute();

      expect(result.success).toBe(false);
      expect(result.error).toBe(originalSyncError);
      expect((result.error as SyncError).type).toBe(SyncErrorType.SyncNetworkError);

      // Verify sync status transitions
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.InProgress);
      expect(mockMetadataManager.updateSyncStatus).toHaveBeenCalledWith(testKey, SyncStatus.Failed);
    });
  });

  describe('Retry Logic', () => {
    it('should allow retry for retryable errors', async () => {
      const retryableError = new SyncError(
        'Network timeout',
        SyncErrorType.SyncTimeout
      );

      // Mock firestore to throw retryable error
      mockFirestore.delete.mockRejectedValueOnce(retryableError);

      const result = await deleteOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(true);
    });

    it('should not allow retry for configuration errors', async () => {
      const nonRetryableError = new SyncError(
        'Configuration error',
        SyncErrorType.SyncConfigurationError
      );

      // Mock firestore to throw non-retryable error
      mockFirestore.delete.mockRejectedValueOnce(nonRetryableError);

      const result = await deleteOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
    });

    it('should not allow retry for validation errors', async () => {
      const validationError = new SyncError(
        'Validation failed',
        SyncErrorType.SyncValidationError
      );

      // Mock firestore to throw validation error
      mockFirestore.delete.mockRejectedValueOnce(validationError);

      const result = await deleteOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
    });
  });

  describe('Inheritance and Interface Compliance', () => {
    it('should implement ISyncOperation interface', () => {
      expect(typeof deleteOperation.execute).toBe('function');
    });

    it('should extend BaseSyncOperation with correct dependencies', () => {
      // Verify the operation has access to protected properties
      expect(deleteOperation).toHaveProperty('key');
      expect((deleteOperation as any).key).toBe(testKey);
    });

    it('should have correct retry configuration from base class', () => {
      // Access protected properties for testing
      const operation = deleteOperation as any;
      expect(operation.maxRetries).toBe(3);
      expect(operation.baseRetryDelay).toBe(1000);
      expect(operation.retryCount).toBe(0);
    });
  });
});
