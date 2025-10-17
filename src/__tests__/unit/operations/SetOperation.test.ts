import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import SetOperation from '../../../sync/operations/SetOperation';
import { TestStorageMapping } from '../../../__mocks__/MockConfig';
import { SyncStatus } from '../../../models/sync/SyncStatus';
import SyncError, { SyncErrorType } from '../../../errors/SyncError';
import { 
  createMockStorageManager, 
  createMockFirestoreManager, 
  createMockMetadataManagerInstance 
} from '../../utils/TestSetupUtils';

// Mock Log (including verbose) to avoid noise in tests
jest.mock('../../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn()
}));

// Mock computeHash function to return predictable values for tests
jest.mock('../../../utils/computeHash', () => {
  return jest.fn((value) => value === undefined ? '' : `hash_${JSON.stringify(value)}`);
});

describe('SetOperation', () => {
  let setOperation: SetOperation<TestStorageMapping>;
  let mockStorage: ReturnType<typeof createMockStorageManager<TestStorageMapping>>;
  let mockFirestore: ReturnType<typeof createMockFirestoreManager<TestStorageMapping>>;
  let mockMetadataManager: ReturnType<typeof createMockMetadataManagerInstance<TestStorageMapping>>;
  const testKey = 'user';

  beforeEach(() => {
    // Create mocks using utility functions
    mockStorage = createMockStorageManager<TestStorageMapping>();
    mockFirestore = createMockFirestoreManager<TestStorageMapping>();
    mockMetadataManager = createMockMetadataManagerInstance<TestStorageMapping>();

    setOperation = new SetOperation(
      testKey,
      mockStorage,
      mockFirestore,
      mockMetadataManager
    );
  });

  describe('Successful Execution', () => {
    it('should successfully backup existing value from storage', async () => {
      // Setup initial data
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      mockStorage.set(testKey, testUser);

      // Mock fetch to return the same value
      mockFirestore.fetch = (jest.fn() as any).mockResolvedValueOnce(testUser);

      // Execute set operation
      const result = await setOperation.execute();

      // Verify successful result
      expect(result.success).toBe(true);
      expect(result.key).toBe(testKey);
      expect(result.error).toBeUndefined();
      expect(result.shouldRetry).toBeUndefined();

      // Verify transaction was used
      expect(mockFirestore.runTransaction).toHaveBeenCalledTimes(1);
      expect(mockFirestore.backup).toHaveBeenCalledWith(testKey, testUser, expect.any(Object));

      // Verify metadata was updated
      const metadata = mockMetadataManager.get(testKey);
      expect(metadata.syncStatus).toBe(SyncStatus.Synced);
      expect(metadata.digest).toBe(`hash_${JSON.stringify(testUser)}`);
      expect(metadata.version).toBeGreaterThan(0);
    });

    it('should handle undefined value backup', async () => {
      // Setup storage to contain the key but with undefined value
      mockStorage.set(testKey, undefined as any);

      // Mock fetch to return undefined
      mockFirestore.fetch = (jest.fn() as any).mockResolvedValue(undefined);

      const result = await setOperation.execute();

      // Should succeed
      expect(result.success).toBe(true);
      expect(result.key).toBe(testKey);

      // Verify transaction was used
      expect(mockFirestore.runTransaction).toHaveBeenCalledTimes(1);
      expect(mockFirestore.backup).toHaveBeenCalledWith(testKey, undefined, expect.any(Object));

      // Verify metadata was updated with empty digest for undefined
      const metadata = mockMetadataManager.get(testKey);
      expect(metadata.syncStatus).toBe(SyncStatus.Synced);
      expect(metadata.digest).toBe('');
    });

    it('should handle null value backup', async () => {
      // Setup storage to contain the key but with null value
      mockStorage.set(testKey, null as any);

      // Mock fetch to return null
      mockFirestore.fetch = (jest.fn() as any).mockResolvedValue(null);

      const result = await setOperation.execute();

      // Should succeed
      expect(result.success).toBe(true);
      expect(result.key).toBe(testKey);

      // Verify transaction was used
      expect(mockFirestore.runTransaction).toHaveBeenCalledTimes(1);
      expect(mockFirestore.backup).toHaveBeenCalledWith(testKey, null, expect.any(Object));

      // Verify metadata was updated
      const metadata = mockMetadataManager.get(testKey);
      expect(metadata.syncStatus).toBe(SyncStatus.Synced);
      expect(metadata.digest).toBe(`hash_${JSON.stringify(null)}`);
    });
  });

  describe('Error Handling', () => {
    it('should handle firestore backup failure', async () => {
      // Setup data and make firestore fail
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      (mockStorage.get as jest.Mock).mockReturnValue(testUser);
      // Simulate transaction failure
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw new SyncError('Mock backup failure', SyncErrorType.SyncNetworkError);
      });

      const result = await setOperation.execute();

      // Verify error result
      expect(result.success).toBe(false);
      expect(result.key).toBe(testKey);
      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.error?.message).toContain('Mock backup failure');
      expect(result.shouldRetry).toBe(true);
    });

    it('should convert non-SyncError to SyncError', async () => {
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      (mockStorage.get as jest.Mock).mockReturnValue(testUser);
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('Regular error');
      });

      const result = await setOperation.execute();

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.error?.message).toContain('Operation failed: Error: Regular error');
      expect((result.error as SyncError).type).toBe(SyncErrorType.SyncFailed);
    });

    it('should preserve SyncError when thrown', async () => {
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      (mockStorage.get as jest.Mock).mockReturnValue(testUser);
      const originalSyncError = new SyncError(
        'Test sync error',
        SyncErrorType.SyncNetworkError
      );
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw originalSyncError;
      });

      const result = await setOperation.execute();

      expect(result.success).toBe(false);
      expect(result.error).toBe(originalSyncError);
      expect((result.error as SyncError).type).toBe(SyncErrorType.SyncNetworkError);
    });
  });

  describe('Retry Logic', () => {
    it('should allow retry for retryable errors', async () => {
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      mockStorage.set(testKey, testUser);

      const retryableError = new SyncError(
        'Network timeout',
        SyncErrorType.SyncTimeout
      );

      // Mock transaction to throw retryable error
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw retryableError;
      });

      const result = await setOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(true);
    });

    it('should not allow retry for configuration errors', async () => {
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      mockStorage.set(testKey, testUser);

      const nonRetryableError = new SyncError(
        'Configuration error',
        SyncErrorType.SyncConfigurationError
      );

      // Mock transaction to throw non-retryable error
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw nonRetryableError;
      });

      const result = await setOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
    });

    it('should not allow retry for validation errors', async () => {
      const testUser = { id: '123', name: 'Test User', email: 'test@example.com' };
      mockStorage.set(testKey, testUser);

      const validationError = new SyncError(
        'Validation failed',
        SyncErrorType.SyncValidationError
      );

      // Mock transaction to throw validation error
      ((mockFirestore.runTransaction) as jest.Mock).mockImplementationOnce(async () => {
        throw validationError;
      });

      const result = await setOperation.execute();

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
    });
  });

  describe('Inheritance and Interface Compliance', () => {
    it('should implement ISyncOperation interface', () => {
      expect(typeof setOperation.execute).toBe('function');
    });

    it('should extend BaseSyncOperation with correct dependencies', () => {
      // Verify the operation has access to protected properties
      expect(setOperation).toHaveProperty('key');
      expect((setOperation as any).key).toBe(testKey);
    });

    it('should have correct retry configuration from base class', () => {
      // Access protected properties for testing
      const operation = setOperation as any;
      expect(operation.maxRetries).toBe(3);
      expect(operation.baseRetryDelay).toBe(1000);
      expect(operation.retryCount).toBe(0);
    });
  });
});
