import { jest } from '@jest/globals';
import OperationRepo from '../../sync/OperationRepo';
import NetworkMonitor from '../../utils/NetworkMonitor';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import ISyncOperation from '../../models/interfaces/ISyncOperation';
import SyncOperationResult from '../../models/sync/SyncOperationResult';
import { BATCH_SIZE } from '../../constants';
import { MMKV } from 'react-native-mmkv';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import MetadataManager from '../../metadata/MetadataManager';
import SetOperation from '../../sync/operations/SetOperation';
import DeleteOperation from '../../sync/operations/DeleteOperation';
import Log from '../../utils/Log';

// Mock MMKV
jest.mock('react-native-mmkv', () => {
  const mockStorage = new Map<string, string>();
  return {
    MMKV: jest.fn().mockImplementation(() => ({
      set: jest.fn((key: string, value: string) => mockStorage.set(key, value)),
      getString: jest.fn((key: string) => mockStorage.get(key)),
      delete: jest.fn((key: string) => mockStorage.delete(key)),
      clearAll: jest.fn(() => mockStorage.clear()),
    })),
  };
});

// Mock NetworkMonitor
jest.mock('../../utils/NetworkMonitor');

// Mock Log to avoid noise in tests
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

// Test interface extending BaseStorageMapping
interface TestStorageMapping extends BaseStorageMapping {
  testKey1: string;
  testKey2: string;
  testKey3: string;
}

// Mock operation class that implements ISyncOperation
class MockOperation<T extends BaseStorageMapping> implements ISyncOperation<T> {
  private retryCount = 0;
  private maxRetries = 3;

  constructor(
    _key: Extract<keyof T, string>,
    private result: SyncOperationResult<T>
  ) {}

  async execute(): Promise<SyncOperationResult<T>> {
    // Always return the configured result, let OperationRepo handle retry logic
    return this.result;
  }

  incrementRetryCount(): boolean {
    this.retryCount++;
    return this.retryCount <= this.maxRetries;
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }

  resetRetryCount(): void {
    this.retryCount = 0;
  }
}

// Mock dependencies
const mockDeps = {
  storage: {
    get: jest.fn(() => 'mock-value'),
    remove: jest.fn(),
  } as unknown as StorageManager<TestStorageMapping>,
  firestore: {
    runTransaction: jest.fn(async (fn: any) => fn({})),
    backup: jest.fn(),
    delete: jest.fn(),
  } as unknown as FirestoreManager<TestStorageMapping>,
  metadataManager: {
    updateSyncStatus: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
  } as unknown as MetadataManager<TestStorageMapping>,
};

describe('OperationRepo', () => {
  let operationRepo: OperationRepo<TestStorageMapping>;
  let mockNetworkMonitor: jest.Mocked<NetworkMonitor>;
  let mockOperation1: MockOperation<TestStorageMapping>;
  let mockOperation2: MockOperation<TestStorageMapping>;
  let mockStorage: MMKV;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Clear storage before each test
    const storage = new MMKV({ id: 'ganon_operations' });
    storage.clearAll();

    // Setup NetworkMonitor mock
    mockNetworkMonitor = new NetworkMonitor() as jest.Mocked<NetworkMonitor>;
    mockNetworkMonitor.isOnline.mockReturnValue(true);

    // Setup operation mocks
    mockOperation1 = new MockOperation<TestStorageMapping>('testKey1', {
      success: true,
      key: 'testKey1',
      shouldRetry: false
    });

    mockOperation2 = new MockOperation<TestStorageMapping>('testKey2', {
      success: true,
      key: 'testKey2',
      shouldRetry: false
    });

    // Create a new instance for each test to ensure clean state
    operationRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
    mockStorage = (operationRepo as any)._storage;
  });

  describe('addOperation', () => {
    it('should add an operation to pending operations', async () => {
      operationRepo.addOperation('testKey1', mockOperation1);
      const results = await operationRepo.processOperations();
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].key).toBe('testKey1');
    });
  });

  describe('removeOperation', () => {
    it('should remove an operation from pending operations', async () => {
      operationRepo.addOperation('testKey1', mockOperation1);
      operationRepo.removeOperation('testKey1');
      const results = await operationRepo.processOperations();
      expect(results).toHaveLength(0);
    });
  });

  describe('processOperations', () => {
    it('should not process operations when network is offline', async () => {
      mockNetworkMonitor.isOnline.mockReturnValue(false);
      operationRepo.addOperation('testKey1', mockOperation1);

      const results = await operationRepo.processOperations();

      expect(results).toHaveLength(0);
    });

    it('should not process operations when no operations are pending', async () => {
      const results = await operationRepo.processOperations();

      expect(results).toHaveLength(0);
    });

    it('should not process operations when sync is already in progress', async () => {
      // Start a sync operation
      operationRepo.addOperation('testKey1', mockOperation1);
      const firstProcess = operationRepo.processOperations();

      // Try to start another sync while first is in progress
      operationRepo.addOperation('testKey2', mockOperation2);
      const secondProcess = await operationRepo.processOperations();

      expect(secondProcess).toHaveLength(0);

      // Wait for first process to complete
      await firstProcess;
    });

    it('should process operations in batches', async () => {
      // Create more operations than BATCH_SIZE
      const operations = Array.from({ length: BATCH_SIZE + 2 }, (_, i) => {
        const key = `testKey${i}` as Extract<keyof TestStorageMapping, string>;
        return new MockOperation<TestStorageMapping>(key, {
          success: true,
          key,
          shouldRetry: false
        });
      });

      operations.forEach((op, i) => {
        operationRepo.addOperation(`testKey${i}` as Extract<keyof TestStorageMapping, string>, op);
      });

      const results = await operationRepo.processOperations();

      expect(results).toHaveLength(BATCH_SIZE + 2);
      results.forEach((result, i) => {
        expect(result.success).toBe(true);
        expect(result.key).toBe(`testKey${i}`);
      });
    });

    it('should handle operation failures and retries', async () => {
      const error = new Error('Test error');
      const failingOperation = new MockOperation<TestStorageMapping>('testKey1', {
        success: false,
        key: 'testKey1',
        error,
        shouldRetry: true
      });

      operationRepo.addOperation('testKey1', failingOperation);

      const results = await operationRepo.processOperations();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        success: false,
        key: 'testKey1',
        error,
        shouldRetry: true,
      });
    });

    it('should stop processing when network goes offline during sync', async () => {
      // Setup operations
      const operations = Array.from({ length: BATCH_SIZE + 2 }, (_, i) => {
        const key = `testKey${i}` as Extract<keyof TestStorageMapping, string>;
        return new MockOperation<TestStorageMapping>(key, {
          success: true,
          key,
          shouldRetry: false
        });
      });

      // Make network go offline after first call to isOnline (which happens before second batch)
      let networkCheckCount = 0;
      mockNetworkMonitor.isOnline.mockImplementation(() => {
        networkCheckCount++;
        return networkCheckCount === 1; // Only first check returns true
      });

      operations.forEach((op, i) => {
        operationRepo.addOperation(`testKey${i}` as Extract<keyof TestStorageMapping, string>, op);
      });

      const results = await operationRepo.processOperations();
      expect(results.length).toBeLessThanOrEqual(BATCH_SIZE);
    });

    it('should remove successful operations from pending operations', async () => {
      operationRepo.addOperation('testKey1', mockOperation1);

      const results = await operationRepo.processOperations();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      // Try processing again, should not process the same operation
      const secondResults = await operationRepo.processOperations();
      expect(secondResults).toHaveLength(0);
    });
  });

  describe('storage persistence', () => {
    it('should save operations to storage when added', () => {
      const setOp1 = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      const setOp2 = new SetOperation('testKey2', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      operationRepo.addOperation('testKey1', setOp1);
      operationRepo.addOperation('testKey2', setOp2);

      const stored = mockStorage.getString('ganon_pending_operations');
      expect(stored).toBeDefined();
      
      const operations = JSON.parse(stored!);
      expect(operations).toHaveLength(2);
      expect(operations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'set',
          key: 'testKey1',
          retryCount: 0,
          maxRetries: 3
        }),
        expect.objectContaining({
          type: 'set',
          key: 'testKey2',
          retryCount: 0,
          maxRetries: 3
        })
      ]));
    });

    it('should remove operations from storage when removed', () => {
      const setOp1 = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      const setOp2 = new SetOperation('testKey2', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      operationRepo.addOperation('testKey1', setOp1);
      operationRepo.addOperation('testKey2', setOp2);
      operationRepo.removeOperation('testKey1');

      const stored = mockStorage.getString('ganon_pending_operations');
      expect(stored).toBeDefined();
      
      const operations = JSON.parse(stored!);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual(expect.objectContaining({
        type: 'set',
        key: 'testKey2',
        retryCount: 0,
        maxRetries: 3
      }));
    });

    it('should clear storage when all operations are cleared', () => {
      operationRepo.addOperation('testKey1', mockOperation1);
      operationRepo.addOperation('testKey2', mockOperation2);
      operationRepo.clearAll();

      const stored = mockStorage.getString('ganon_pending_operations');
      expect(stored).toBeUndefined();
    });

    it('should load pending operation keys from storage on initialization', async () => {
      // Setup initial storage state
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        {
          type: 'set',
          key: 'testKey1',
          retryCount: 0,
          maxRetries: 3
        },
        {
          type: 'set',
          key: 'testKey2',
          retryCount: 0,
          maxRetries: 3
        }
      ]));

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Process operations to verify they were added
      const results = await newRepo.processOperations();
      expect(results).toHaveLength(2);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          success: true,
          key: 'testKey1'
        }),
        expect.objectContaining({
          success: true,
          key: 'testKey2'
        })
      ]));
    });

    it('should load operations with non-zero retry counts correctly', async () => {
      // Setup initial storage state with operations that have been retried
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        {
          type: 'set',
          key: 'testKey1',
          retryCount: 2,
          maxRetries: 3
        },
        {
          type: 'delete',
          key: 'testKey2',
          retryCount: 1,
          maxRetries: 3
        }
      ]));

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Verify retry counts are preserved
      const op1 = newRepo['_pendingOperations'].get('testKey1');
      const op2 = newRepo['_pendingOperations'].get('testKey2');
      expect(op1?.getRetryCount()).toBe(2);
      expect(op2?.getRetryCount()).toBe(1);

      // Process operations to verify they can still be executed
      const results = await newRepo.processOperations();
      expect(results).toHaveLength(2);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          success: true,
          key: 'testKey1'
        }),
        expect.objectContaining({
          success: true,
          key: 'testKey2'
        })
      ]));
    });

    it('should load operations that have reached max retries but not remove them', async () => {
      // Setup initial storage state with operations at max retries
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        {
          type: 'set',
          key: 'testKey1',
          retryCount: 3,
          maxRetries: 3
        },
        {
          type: 'delete',
          key: 'testKey2',
          retryCount: 3,
          maxRetries: 3
        }
      ]));

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Create operations with execute method spied on
      const failingOp1 = new MockOperation<TestStorageMapping>('testKey1', {
        success: false,
        key: 'testKey1',
        error: new Error('Test error'),
        shouldRetry: true
      });
      const failingOp2 = new MockOperation<TestStorageMapping>('testKey2', {
        success: false,
        key: 'testKey2',
        error: new Error('Test error'),
        shouldRetry: true
      });
      
      // Manually set retry counts to max
      for (let i = 0; i < 3; i++) {
        failingOp1.incrementRetryCount();
        failingOp2.incrementRetryCount();
      }

      // Spy on execute methods
      const executeSpy1 = jest.spyOn(failingOp1, 'execute');
      const executeSpy2 = jest.spyOn(failingOp2, 'execute');
      
      newRepo['_pendingOperations'].set('testKey1', failingOp1);
      newRepo['_pendingOperations'].set('testKey2', failingOp2);

      // Verify operations are still loaded with max retries
      const op1 = newRepo['_pendingOperations'].get('testKey1');
      const op2 = newRepo['_pendingOperations'].get('testKey2');
      expect(op1).toBeDefined();
      expect(op2).toBeDefined();
      expect(op1?.getRetryCount()).toBe(3);
      expect(op2?.getRetryCount()).toBe(3);

      // Process operations
      const results = await newRepo.processOperations();
      
      // Verify operations were not executed
      expect(executeSpy1).not.toHaveBeenCalled();
      expect(executeSpy2).not.toHaveBeenCalled();
      
      // Verify operations were removed from queue
      expect(newRepo['_pendingOperations'].get('testKey1')).toBeUndefined();
      expect(newRepo['_pendingOperations'].get('testKey2')).toBeUndefined();
      
      // Verify correct results were returned
      expect(results).toHaveLength(2);
      const [result1, result2] = results;
      expect(results).toEqual([
        {
          success: false,
          key: 'testKey1',
          error: expect.any(Error),
          shouldRetry: false
        },
        {
          success: false,
          key: 'testKey2',
          error: expect.any(Error),
          shouldRetry: false
        }
      ]);
      
      // TypeScript needs help understanding these are defined and have errors
      if (!result1 || !result2) {
        throw new Error('Results should be defined');
      }
      if (!result1.error || !result2.error) {
        throw new Error('Results should have errors');
      }
      
      expect(result1.error.message).toBe('Operation exceeded max retries');
      expect(result2.error.message).toBe('Operation exceeded max retries');
    });

    it('should load and retry failed operations on initialization', async () => {
      // Setup initial storage state with a failed operation
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        {
          type: 'set',
          key: 'testKey1',
          retryCount: 1,
          maxRetries: 3
        }
      ]));

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Get the operation that was loaded
      const loadedOp = newRepo['_pendingOperations'].get('testKey1');
      expect(loadedOp?.getRetryCount()).toBe(1);

      // Replace with failing operation but preserve retry count
      const failingOperation = new MockOperation<TestStorageMapping>('testKey1', {
        success: false,
        key: 'testKey1',
        error: new Error('Test error'),
        shouldRetry: true
      });
      // Set initial retry count to match loaded operation
      for (let i = 0; i < loadedOp!.getRetryCount(); i++) {
        failingOperation.incrementRetryCount();
      }
      
      newRepo['_pendingOperations'].set('testKey1', failingOperation);

      // Process operations to verify retry behavior
      const results = await newRepo.processOperations();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        success: false,
        key: 'testKey1',
        error: expect.any(Error),
        shouldRetry: true
      });

      // Verify retry count was incremented from initial value
      const op = newRepo['_pendingOperations'].get('testKey1');
      expect(op?.getRetryCount()).toBe(2);
    });

    it('should handle mixed operation types during initialization', async () => {
      // Setup initial storage state with mixed operation types
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        {
          type: 'set',
          key: 'testKey1',
          retryCount: 0,
          maxRetries: 3
        },
        {
          type: 'delete',
          key: 'testKey2',
          retryCount: 0,
          maxRetries: 3
        },
        {
          type: 'set',
          key: 'testKey3',
          retryCount: 1,
          maxRetries: 3
        }
      ]));

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Verify all operations are loaded with correct types
      const setOp1 = newRepo['_pendingOperations'].get('testKey1');
      const deleteOp = newRepo['_pendingOperations'].get('testKey2');
      const setOp2 = newRepo['_pendingOperations'].get('testKey3');

      expect(setOp1).toBeInstanceOf(SetOperation);
      expect(deleteOp).toBeInstanceOf(DeleteOperation);
      expect(setOp2).toBeInstanceOf(SetOperation);
      expect(setOp2?.getRetryCount()).toBe(1);

      // Process operations to verify they can be executed
      const results = await newRepo.processOperations();
      expect(results).toHaveLength(3);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          success: true,
          key: 'testKey1'
        }),
        expect.objectContaining({
          success: true,
          key: 'testKey2'
        }),
        expect.objectContaining({
          success: true,
          key: 'testKey3'
        })
      ]));
    });

    it('should handle storage errors gracefully', async () => {
      // Mock storage error
      jest.spyOn(mockStorage, 'set').mockImplementationOnce(() => {
        throw new Error('Storage error');
      });
      const setOp1 = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      // Should not throw when adding operation
      expect(() => {
        operationRepo.addOperation('testKey1', setOp1);
      }).not.toThrow();
      // Operation should still be in memory
      const results = await operationRepo.processOperations();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(expect.objectContaining({
        success: true,
        key: 'testKey1'
      }));
    });

    it('should handle corrupted storage data gracefully', async () => {
      // Setup corrupted storage data
      mockStorage.set('ganon_pending_operations', 'invalid json');

      // Create a new instance to test initialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Should not throw and should start with empty operations
      const results = await newRepo.processOperations();
      expect(results).toHaveLength(0);
    });
  });

  describe('operation serialization', () => {
    it('should serialize and deserialize SetOperation', () => {
      const setOp = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      setOp.incrementRetryCount(); // Set some state

      operationRepo.addOperation('testKey1', setOp);
      const stored = mockStorage.getString('ganon_pending_operations');
      expect(stored).toBeDefined();

      const operations = JSON.parse(stored!);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual({
        type: 'set',
        key: 'testKey1',
        retryCount: 1,
        maxRetries: 3,
      });

      // Create new repo to test deserialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      const restoredOp = newRepo['_pendingOperations'].get('testKey1');
      expect(restoredOp).toBeInstanceOf(SetOperation);
      expect(restoredOp?.getRetryCount()).toBe(1);
    });

    it('should serialize and deserialize DeleteOperation', () => {
      const deleteOp = new DeleteOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      deleteOp.incrementRetryCount(); // Set some state

      operationRepo.addOperation('testKey1', deleteOp);
      const stored = mockStorage.getString('ganon_pending_operations');
      expect(stored).toBeDefined();

      const operations = JSON.parse(stored!);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual({
        type: 'delete',
        key: 'testKey1',
        retryCount: 1,
        maxRetries: 3,
      });

      // Create new repo to test deserialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      const restoredOp = newRepo['_pendingOperations'].get('testKey1');
      expect(restoredOp).toBeInstanceOf(DeleteOperation);
      expect(restoredOp?.getRetryCount()).toBe(1);
    });

    it('should handle mixed operation types', () => {
      const setOp = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      const deleteOp = new DeleteOperation('testKey2', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);

      operationRepo.addOperation('testKey1', setOp);
      operationRepo.addOperation('testKey2', deleteOp);

      // Create new repo to test deserialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      const restoredSetOp = newRepo['_pendingOperations'].get('testKey1');
      const restoredDeleteOp = newRepo['_pendingOperations'].get('testKey2');

      expect(restoredSetOp).toBeInstanceOf(SetOperation);
      expect(restoredDeleteOp).toBeInstanceOf(DeleteOperation);
    });

    it('should handle missing dependencies gracefully', () => {
      const repoWithoutDeps = new OperationRepo<TestStorageMapping>(mockNetworkMonitor);
      const setOp = new SetOperation('testKey1', mockDeps.storage, mockDeps.firestore, mockDeps.metadataManager);
      
      // Should not throw when adding operation without deps
      expect(() => {
        repoWithoutDeps.addOperation('testKey1', setOp);
      }).not.toThrow();

      // Should warn when trying to load operations without deps
      repoWithoutDeps['_loadPendingOperations']();
      expect(Log.warn).toHaveBeenCalledWith('Ganon: Cannot load pending operations without dependencies');
    });

    it('should handle corrupted operation data gracefully', () => {
      // Setup corrupted storage data
      mockStorage.set('ganon_pending_operations', JSON.stringify([
        { type: 'invalid', key: 'testKey1' }, // Invalid type
        { type: 'set' }, // Missing key
        { type: 'delete', key: 'testKey2', retryCount: 'invalid' }, // Invalid retryCount
      ]));

      // Create new repo to test deserialization
      const newRepo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps);
      
      // Should log errors for each invalid operation
      expect(Log.error).toHaveBeenCalledTimes(3);
      expect(newRepo['_pendingOperations'].size).toBe(0);
    });
  });
});
