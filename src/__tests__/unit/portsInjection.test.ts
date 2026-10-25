import { jest } from '@jest/globals';
import StorageManager from '../../managers/StorageManager';
import OperationRepo from '../../sync/OperationRepo';
import ChunkManager from '../../firestore/chunking/ChunkManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import DataProcessor from '../../firestore/processing/DataProcessor';
import NetworkMonitor from '../../utils/NetworkMonitor';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeScheduler } from '../utils/FakeScheduler';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { GanonConfig } from '../../models/config/GanonConfig';
import FirestoreManager from '../../firestore/FirestoreManager';
import MetadataManager from '../../metadata/MetadataManager';
import SetOperation from '../../sync/operations/SetOperation';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';

jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

jest.mock('../../utils/NetworkMonitor');

jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  setDoc: jest.fn(() => Promise.resolve()),
  updateDoc: jest.fn(() => Promise.resolve()),
  deleteDoc: jest.fn(() => Promise.resolve()),
  getDoc: jest.fn(() => Promise.resolve({})),
  getDocs: jest.fn(() => Promise.resolve({})),
  writeBatch: jest.fn(() => ({
    set: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn(() => Promise.resolve()),
  })),
  runTransaction: jest.fn((_firestore, updateFunction) =>
    updateFunction({
      get: jest.fn(() => Promise.resolve({})),
      set: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    })
  ),
  Timestamp: {
    fromDate: (date: Date) => date,
  },
}));

interface TestStorageMapping extends BaseStorageMapping {
  user: { name: string };
  testKey1: string;
}

const createTestConfig = (): GanonConfig<TestStorageMapping> => ({
  identifierKey: 'testKey1',
  cloudConfig: {
    firestore: {
      collection: 'test-collection',
    },
  } as GanonConfig<TestStorageMapping>['cloudConfig'],
  remoteReadonly: false,
});

describe('Port injection smoke tests', () => {
  describe('KeyValueStore → StorageManager', () => {
    it('round-trips data through an injected in-memory store', () => {
      const kv = new MMKVFaker();
      const storage = new StorageManager<TestStorageMapping>(kv);

      storage.set('user', { name: 'Alice' });

      const reloaded = new StorageManager<TestStorageMapping>(kv);
      expect(reloaded.get('user')).toEqual({ name: 'Alice' });
      expect(kv.getString('user')).toBe(JSON.stringify({ name: 'Alice' }));
    });
  });

  describe('KeyValueStore → OperationRepo', () => {
    let mockNetworkMonitor: jest.Mocked<NetworkMonitor>;

    const mockDeps = {
      storage: {
        get: jest.fn(() => 'mock-value'),
        remove: jest.fn(),
      } as unknown as StorageManager<TestStorageMapping>,
      firestore: {
        runTransaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({})),
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

    beforeEach(() => {
      jest.clearAllMocks();
      mockNetworkMonitor = new NetworkMonitor() as jest.Mocked<NetworkMonitor>;
      mockNetworkMonitor.isOnline.mockReturnValue(true);
    });

    it('persists pending operations through an injected operations store', () => {
      const kv = new MMKVFaker();
      const operation = new SetOperation(
        'testKey1',
        mockDeps.storage,
        mockDeps.firestore,
        mockDeps.metadataManager
      );

      const repo = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps, kv);
      repo.addOperation('testKey1', operation);

      expect(kv.getString('ganon_pending_operations')).toBeDefined();

      const reloaded = new OperationRepo<TestStorageMapping>(mockNetworkMonitor, mockDeps, kv);
      expect((reloaded as unknown as { _pendingOperations: Map<string, unknown> })._pendingOperations.has('testKey1')).toBe(
        true
      );
    });
  });

  describe('Scheduler → ChunkManager', () => {
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 50;

    it('calls injected scheduler delay once between chunked write batches', async () => {
      const scheduler = new FakeScheduler();
      const delaySpy = jest.spyOn(scheduler, 'delay').mockResolvedValue(undefined);

      const mockBatch = {
        set: jest.fn(),
        delete: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
      };

      const mockCollectionRef = {
        path: 'test-collection/test-key',
        doc: jest.fn().mockImplementation((id: string) => ({ id })),
        get: jest.fn(),
      } as unknown as FirebaseFirestoreTypes.CollectionReference;

      const mockAdapter = new FirestoreAdapter(createTestConfig()) as jest.Mocked<
        FirestoreAdapter<TestStorageMapping>
      >;
      mockAdapter.writeBatch = jest.fn().mockReturnValue(mockBatch);
      mockAdapter.getCollection = jest.fn().mockResolvedValue({
        empty: false,
        docs: [],
      } as FirebaseFirestoreTypes.QuerySnapshot);

      const mockDataProcessor = {
        sanitizeForFirestore: jest.fn((data: unknown) => data),
        validateForFirestore: jest.fn(() => ({ isValid: true, errors: [] })),
        restoreFromFirestore: jest.fn((data: unknown) => data),
        calculateDataSize: jest.fn(() => 0),
      } as unknown as DataProcessor;

      const chunkManager = new ChunkManager(mockAdapter, mockDataProcessor, scheduler);
      jest.spyOn(chunkManager as unknown as { calculateDataSize: (data: unknown) => number }, 'calculateDataSize').mockReturnValue(
        250_000
      );

      const chunks = Array.from({ length: 15 }, (_, i) => ({ [`field${i}`]: `value${i}` }));
      const expectedDelayCalls = Math.ceil(chunks.length / BATCH_SIZE) - 1;
      jest
        .spyOn(require('../../firestore/chunking/helpers/chunkGeneration'), 'generateChunks')
        .mockResolvedValue(chunks);

      await chunkManager.writeData(mockCollectionRef, 'test-key', { field0: 'value0' });

      expect(delaySpy).toHaveBeenCalledWith(BATCH_DELAY);
      expect(delaySpy).toHaveBeenCalledTimes(expectedDelayCalls);
      expect(mockBatch.commit).toHaveBeenCalled();
    });
  });
});
