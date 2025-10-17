import BaseSyncOperation from '../../sync/operations/BaseSyncOperation';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import { MockMetadataManager } from '../../__mocks__/MockMetadataManager';
import SyncOperationResult from '../../models/sync/SyncOperationResult';
import SyncError, { SyncErrorType } from '../../errors/SyncError';
import UserManager from '../../managers/UserManager';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../utils/Log');
jest.mock('../../managers/UserManager');

interface TestStorage {
  email: string;
  key1: string;
  key2: number;
  lastBackup: number;
}

// Test implementation of BaseSyncOperation
class TestSyncOperation extends BaseSyncOperation<TestStorage> {
  constructor(
    key: Extract<keyof TestStorage, string>,
    storage: StorageManager<TestStorage>,
    firestore: FirestoreManager<TestStorage>,
    metadataManager: MockMetadataManager<TestStorage>,
    private shouldSucceed: boolean = true,
    private errorToThrow?: Error
  ) {
    super(key, storage, firestore, metadataManager);
  }

  async execute(): Promise<SyncOperationResult<TestStorage>> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    if (this.shouldSucceed) {
      return { success: true, key: this.key };
    } else {
      return { success: false, key: this.key, shouldRetry: true };
    }
  }

  serialize(): object {
    return {
      type: 'test',
      key: this.key,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
    };
  }
}

describe('BaseSyncOperation Retry Tests', () => {
  let testOperation: TestSyncOperation;
  let mockStorage: jest.Mocked<StorageManager<TestStorage>>;
  let mockFirestore: jest.Mocked<FirestoreManager<TestStorage>>;
  let mockMetadataManager: MockMetadataManager<TestStorage>;
  let mockUserManager: jest.Mocked<UserManager<TestStorage>>;

  beforeEach(() => {
    // Create mocks
    mockStorage = new StorageManager() as jest.Mocked<StorageManager<TestStorage>>;
    mockUserManager = new UserManager<TestStorage>(
      'email',
      mockStorage
    ) as jest.Mocked<UserManager<TestStorage>>;
    mockFirestore = new FirestoreManager(
      'userId',
      {},
      {} as any,
      mockUserManager
    ) as jest.Mocked<FirestoreManager<TestStorage>>;
    mockMetadataManager = new MockMetadataManager<TestStorage>();

    testOperation = new TestSyncOperation(
      'key1',
      mockStorage,
      mockFirestore,
      mockMetadataManager
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('retry count management', () => {
    it('should start with retry count of 0', () => {
      expect(testOperation.getRetryCount()).toBe(0);
    });

    it('should increment retry count correctly', () => {
      expect(testOperation.incrementRetryCount()).toBe(true);
      expect(testOperation.getRetryCount()).toBe(1);

      expect(testOperation.incrementRetryCount()).toBe(true);
      expect(testOperation.getRetryCount()).toBe(2);

      expect(testOperation.incrementRetryCount()).toBe(true);
      expect(testOperation.getRetryCount()).toBe(3);
    });

    it('should return false when max retries exceeded', () => {
      // Increment to max retries (3)
      testOperation.incrementRetryCount();
      testOperation.incrementRetryCount();
      testOperation.incrementRetryCount();
      
      // Fourth increment should return false
      expect(testOperation.incrementRetryCount()).toBe(false);
      expect(testOperation.getRetryCount()).toBe(4);
    });

    it('should reset retry count to 0', () => {
      testOperation.incrementRetryCount();
      testOperation.incrementRetryCount();
      expect(testOperation.getRetryCount()).toBe(2);

      testOperation.resetRetryCount();
      expect(testOperation.getRetryCount()).toBe(0);
    });

    it('should return correct max retries value', () => {
      expect(testOperation.getMaxRetries()).toBe(3);
    });
  });

  describe('error handling', () => {
    it('should handle SyncError with non-retryable error type', () => {
      const configError = new SyncError('Config error', SyncErrorType.SyncConfigurationError);
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        false,
        configError
      );

      const result = (operation as any).handleError(configError);

      expect(result.success).toBe(false);
      expect(result.key).toBe('key1');
      expect(result.error).toBe(configError);
      expect(result.shouldRetry).toBe(false);
    });

    it('should handle SyncError with retryable error type when retries available', () => {
      const networkError = new SyncError('Network error', SyncErrorType.SyncFailed);
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        false,
        networkError
      );

      const result = (operation as any).handleError(networkError);

      expect(result.success).toBe(false);
      expect(result.key).toBe('key1');
      expect(result.error).toBe(networkError);
      expect(result.shouldRetry).toBe(true);
    });

    it('should not retry when max retries exceeded', () => {
      const networkError = new SyncError('Network error', SyncErrorType.SyncFailed);
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        false,
        networkError
      );

      // Exceed max retries
      operation.incrementRetryCount();
      operation.incrementRetryCount();
      operation.incrementRetryCount();
      operation.incrementRetryCount();

      const result = (operation as any).handleError(networkError);

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
    });

    it('should handle non-SyncError as retryable', () => {
      const genericError = new Error('Generic error');
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        false,
        genericError
      );

      const result = (operation as any).handleError(genericError);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.shouldRetry).toBe(true);
    });

    it('should convert non-SyncError to SyncError', () => {
      const genericError = new Error('Generic error');
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager,
        false,
        genericError
      );

      const result = (operation as any).handleError(genericError);

      expect(result.error).toBeInstanceOf(SyncError);
      expect(result.error.message).toContain('Operation failed');
      expect(result.error.message).toContain('Generic error');
    });
  });

  describe('non-retryable error types', () => {
    const nonRetryableErrorTypes = [
      SyncErrorType.SyncConfigurationError,
      SyncErrorType.SyncConflict,
      SyncErrorType.SyncValidationError,
      SyncErrorType.SyncMultipleErrors,
    ];

    nonRetryableErrorTypes.forEach(errorType => {
      it(`should not retry for ${errorType}`, () => {
        const syncError = new SyncError('Test error', errorType);
        const operation = new TestSyncOperation(
          'key1',
          mockStorage,
          mockFirestore,
          mockMetadataManager,
          false,
          syncError
        );

        const result = (operation as any).handleError(syncError);

        expect(result.shouldRetry).toBe(false);
      });
    });
  });

  describe('retryable error types', () => {
    const retryableErrorTypes = [
      SyncErrorType.SyncFailed,
      SyncErrorType.SyncNetworkError,
      SyncErrorType.SyncTimeout,
    ];

    retryableErrorTypes.forEach(errorType => {
      it(`should retry for ${errorType} when retries available`, () => {
        const syncError = new SyncError('Test error', errorType);
        const operation = new TestSyncOperation(
          'key1',
          mockStorage,
          mockFirestore,
          mockMetadataManager,
          false,
          syncError
        );

        const result = (operation as any).handleError(syncError);

        expect(result.shouldRetry).toBe(true);
      });
    });
  });

  describe('retry delay calculation', () => {
    it('should calculate exponential backoff delay correctly', () => {
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager
      );

      // Base delay should be 1000ms
      expect((operation as any).getRetryDelay()).toBe(1000);

      // After first retry: 1000 * 2^1 = 2000ms
      operation.incrementRetryCount();
      expect((operation as any).getRetryDelay()).toBe(2000);

      // After second retry: 1000 * 2^2 = 4000ms
      operation.incrementRetryCount();
      expect((operation as any).getRetryDelay()).toBe(4000);

      // After third retry: 1000 * 2^3 = 8000ms
      operation.incrementRetryCount();
      expect((operation as any).getRetryDelay()).toBe(8000);
    });

    it('should use base retry delay of 1000ms', () => {
      const operation = new TestSyncOperation(
        'key1',
        mockStorage,
        mockFirestore,
        mockMetadataManager
      );

      expect((operation as any).baseRetryDelay).toBe(1000);
    });
  });

  describe('interface compliance', () => {
    it('should implement all required ISyncOperation methods', () => {
      expect(typeof testOperation.execute).toBe('function');
      expect(typeof testOperation.incrementRetryCount).toBe('function');
      expect(typeof testOperation.getRetryCount).toBe('function');
      expect(typeof testOperation.getMaxRetries).toBe('function');
      expect(typeof testOperation.resetRetryCount).toBe('function');
    });

    it('should return operation result with correct structure', async () => {
      const result = await testOperation.execute();

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('key');
      expect(result.key).toBe('key1');
    });
  });

  describe('edge cases', () => {
    it('should handle multiple resets correctly', () => {
      testOperation.incrementRetryCount();
      testOperation.incrementRetryCount();
      testOperation.resetRetryCount();
      testOperation.resetRetryCount(); // Multiple resets

      expect(testOperation.getRetryCount()).toBe(0);
    });

    it('should handle increment beyond max retries', () => {
      // Increment beyond max
      for (let i = 0; i < 10; i++) {
        testOperation.incrementRetryCount();
      }

      expect(testOperation.getRetryCount()).toBe(10);
      // Should still return false for further attempts
      expect(testOperation.incrementRetryCount()).toBe(false);
    });
  });
}); 