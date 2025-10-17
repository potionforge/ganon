import SetOperation from '../../sync/operations/SetOperation';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import { SyncStatus } from '../../models/sync/SyncStatus';
import computeHash from '../../utils/computeHash';
import MetadataManager from '../../metadata/MetadataManager';
import { MockFirestoreAdapter } from '../../__mocks__/MockFirestoreAdapter';
import { GanonConfig } from '../../models/config/GanonConfig';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import { getFirestore, FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import UserManager from '../../managers/UserManager';

// Mock dependencies
jest.mock('../../managers/StorageManager');
jest.mock('../../firestore/FirestoreManager');
jest.mock('../../metadata/MetadataManager');
jest.mock('../../metadata/MetadataCoordinatorRepo');
jest.mock('../../utils/computeHash');
jest.mock('../../utils/Log');
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(),
  FirebaseFirestoreTypes: {
    DocumentReference: jest.fn(),
    CollectionReference: jest.fn(),
    DocumentSnapshot: jest.fn(),
    QuerySnapshot: jest.fn(),
    WriteBatch: jest.fn(),
    Transaction: jest.fn(),
    SetOptions: jest.fn()
  }
}));

// Add mock for UserManager
jest.mock('../../managers/UserManager');

interface TestStorage extends BaseStorageMapping {
  key1: string;
  key2: number;
  lastBackup: number;
}

// Extend MetadataManager mock type to include remove method
interface MockMetadataManager<T extends BaseStorageMapping> extends jest.Mocked<MetadataManager<T>> {
  remove: jest.Mock;
}

// Create a proper mock adapter that extends FirestoreAdapter
class TestFirestoreAdapter extends FirestoreAdapter<TestStorage> {
  constructor() {
    super({
      identifierKey: 'key1',
      cloudConfig: {
        test: {
          docKeys: ['key1', 'key2', 'lastBackup']
        }
      } as any
    });
    // Override the private firestore property using Object.defineProperty
    Object.defineProperty(this, 'firestore', {
      value: getFirestore(),
      writable: false
    });
  }

  async getDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    return (new MockFirestoreAdapter()).getDocument(ref);
  }

  async setDocument(
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    return (new MockFirestoreAdapter()).setDocument(ref, data, options);
  }

  async updateDocument(ref: FirebaseFirestoreTypes.DocumentReference, data: any): Promise<void> {
    return (new MockFirestoreAdapter()).updateDocument(ref, data);
  }

  async deleteDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<void> {
    return (new MockFirestoreAdapter()).deleteDocument(ref);
  }

  async getCollection(ref: FirebaseFirestoreTypes.CollectionReference): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    return (new MockFirestoreAdapter()).getCollection(ref);
  }

  async runTransaction<T>(updateFunction: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<T>): Promise<T> {
    return (new MockFirestoreAdapter()).runTransaction(updateFunction);
  }

  writeBatch(): FirebaseFirestoreTypes.WriteBatch {
    return (new MockFirestoreAdapter()).writeBatch();
  }
}

describe('SetOperation Sync Status Tests', () => {
  let setOperation: SetOperation<TestStorage>;
  let storageManager: jest.Mocked<StorageManager<TestStorage>>;
  let firestoreManager: jest.Mocked<FirestoreManager<TestStorage>>;
  let metadataManager: MockMetadataManager<TestStorage>;
  let config: GanonConfig<TestStorage>;
  let adapter: TestFirestoreAdapter;
  let mockUserManager: jest.Mocked<UserManager<TestStorage>>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup test data
    config = {
      identifierKey: 'key1',
      cloudConfig: {
        test: {
          docKeys: ['key1', 'key2', 'lastBackup']
        }
      }
    };

    // Initialize managers with mocks
    storageManager = new StorageManager<TestStorage>() as jest.Mocked<StorageManager<TestStorage>>;
    adapter = new TestFirestoreAdapter();
    mockUserManager = new UserManager<TestStorage>(config.identifierKey, storageManager) as jest.Mocked<UserManager<TestStorage>>;
    mockUserManager.isUserLoggedIn.mockReturnValue(true);

    firestoreManager = new FirestoreManager<TestStorage>(
      config.identifierKey,
      config.cloudConfig,
      adapter,
      mockUserManager
    ) as jest.Mocked<FirestoreManager<TestStorage>>;

    // Create metadata manager with mocked methods
    metadataManager = {
      updateSyncStatus: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
      remove: jest.fn(),
      getAll: jest.fn(),
      clear: jest.fn(),
    } as unknown as MockMetadataManager<TestStorage>;

    // Setup default mock implementations
    storageManager.get.mockImplementation((key) => {
      if (key === 'key1') return 'test-value';
      if (key === 'key2') return undefined;
      return undefined;
    });
    storageManager.contains.mockImplementation((key) => {
      return key === 'key1' || key === 'key2';
    });

    // Mock firestore methods
    firestoreManager.backup.mockResolvedValue();
    firestoreManager.fetch.mockImplementation((key) => {
      if (key === 'key1') return Promise.resolve('test-value');
      return Promise.resolve(undefined);
    });
    firestoreManager.runTransaction.mockImplementation(async (callback) => {
      const mockTransaction = {
        get: jest.fn(),
        set: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      } as unknown as FirebaseFirestoreTypes.Transaction;
      return callback(mockTransaction);
    });

    // Mock computeHash
    (computeHash as jest.Mock).mockImplementation((value) => {
      if (value === undefined) return '';
      return 'test-hash';
    });

    // Create operation instance
    setOperation = new SetOperation('key1', storageManager, firestoreManager, metadataManager);
  });

  describe('sync status lifecycle', () => {
    it('should set status to InProgress at execution start', async () => {
      // Execute operation
      await setOperation.execute();

      // Verify status was set to InProgress
      expect(metadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.InProgress);
    });

    it('should set status to Synced on successful execution', async () => {
      // Execute operation
      await setOperation.execute();

      // Verify status was set to Synced
      expect(metadataManager.set).toHaveBeenCalledWith('key1', expect.objectContaining({
        syncStatus: SyncStatus.Synced,
        version: expect.any(Number),
        digest: 'test-hash'
      }));
    });

    it('should set status to Failed when operation throws error', async () => {
      // Make firestore fail
      firestoreManager.runTransaction.mockRejectedValueOnce(new Error('Test error'));

      // Execute operation
      await setOperation.execute();

      // Verify status was set to Failed
      expect(metadataManager.updateSyncStatus).toHaveBeenCalledWith('key1', SyncStatus.Failed);
    });
  });

  describe('hash computation', () => {
    it('should compute hash for non-undefined values', async () => {
      // Execute operation
      await setOperation.execute();

      // Verify hash was computed
      expect(computeHash).toHaveBeenCalledWith('test-value');
      expect(metadataManager.set).toHaveBeenCalledWith('key1', expect.objectContaining({
        digest: 'test-hash'
      }));
    });

    it('should use empty string as hash for undefined values', async () => {
      // Create operation with undefined value
      const undefinedOperation = new SetOperation('key2', storageManager, firestoreManager, metadataManager);

      // Execute operation
      await undefinedOperation.execute();

      // Verify empty string was used as hash
      expect(metadataManager.set).toHaveBeenCalledWith('key2', expect.objectContaining({
        digest: ''
      }));
    });
  });
});