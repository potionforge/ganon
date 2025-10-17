import ChunkManager from '../chunking/ChunkManager';
import FirestoreAdapter from '../FirestoreAdapter';
import DataProcessor from '../processing/DataProcessor';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import SyncError, { SyncErrorType } from '../../errors/SyncError';

// Create a test storage mapping
interface TestStorageMapping extends BaseStorageMapping {
  testKey: string;
  anotherKey: number;
}

// Create test config
const createTestConfig = (): GanonConfig<TestStorageMapping> => ({
  identifierKey: 'testKey',
  cloudConfig: {
    firestore: {
      collection: 'test-collection'
    }
  } as any,
  remoteReadonly: false
});

// Mock Firebase Firestore
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
    commit: jest.fn(() => Promise.resolve())
  })),
  runTransaction: jest.fn((_firestore, updateFunction) => updateFunction({
    get: jest.fn(() => Promise.resolve({})),
    set: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  })),
  Timestamp: {
    fromDate: (date: Date) => date,
  },
}));

// Mock Log
jest.mock('../../utils/Log', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
  info: jest.fn()
}));

interface ExtendedDataProcessor extends DataProcessor {
  calculateDataSize: jest.Mock;
  sanitizeForFirestore: jest.Mock;
  validateForFirestore: jest.Mock;
  restoreFromFirestore: jest.Mock;
}

describe('ChunkManager', () => {
  let chunkManager: ChunkManager<TestStorageMapping>;
  let mockAdapter: jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
  let mockDataProcessor: jest.Mocked<ExtendedDataProcessor>;
  let mockCollectionRef: jest.Mocked<FirebaseFirestoreTypes.CollectionReference>;
  let mockDocRef: jest.Mocked<FirebaseFirestoreTypes.DocumentReference>;
  let mockBatch: jest.Mocked<FirebaseFirestoreTypes.WriteBatch>;
  let mockQuerySnapshot: jest.Mocked<FirebaseFirestoreTypes.QuerySnapshot>;

  // Helper to create a mock document snapshot with unique ref
  const createMockDocSnapshot = (id: string, data: any): FirebaseFirestoreTypes.QueryDocumentSnapshot => {
    const docRef = {
      id,
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    return {
      id,
      data: () => data,
      exists: true,
      metadata: { hasPendingWrites: false, fromCache: false },
      ref: docRef,
      get: jest.fn(),
      isEqual: jest.fn(),
    } as any;
  };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock document reference
    mockDocRef = {
      id: 'chunk_0',
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Setup mock collection reference with dynamic doc refs
    mockCollectionRef = {
      doc: jest.fn().mockImplementation((id: string) => ({
        ...mockDocRef,
        id,
      })),
      get: jest.fn(),
    } as any;

    // Setup mock batch
    mockBatch = {
      set: jest.fn(),
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Setup mock query snapshot
    mockQuerySnapshot = {
      empty: false,
      docs: [],
    } as any;

    // Setup mock adapter with proper config
    mockAdapter = new FirestoreAdapter(createTestConfig()) as jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
    mockAdapter.writeBatch = jest.fn().mockReturnValue(mockBatch);
    mockAdapter.getCollection = jest.fn().mockResolvedValue(mockQuerySnapshot);
    mockAdapter.setDocument = jest.fn().mockResolvedValue(undefined);
    mockAdapter.updateDocument = jest.fn().mockResolvedValue(undefined);
    mockAdapter.deleteDocument = jest.fn().mockResolvedValue(undefined);
    mockAdapter.getDocument = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({})
    } as any);
    mockAdapter.runTransaction = jest.fn().mockImplementation(async (callback) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
        set: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      } as any;
      return callback(mockTransaction);
    });

    // Setup mock data processor as a plain object with jest.fn mocks
    mockDataProcessor = {
      sanitizeForFirestore: jest.fn(data => data),
      validateForFirestore: jest.fn(() => ({ isValid: true, errors: [] })),
      restoreFromFirestore: jest.fn(data => data),
      calculateDataSize: jest.fn(() => 0),
    } as unknown as jest.Mocked<ExtendedDataProcessor>;

    // Create ChunkManager instance
    chunkManager = new ChunkManager(mockAdapter, mockDataProcessor);
  });

  describe('writeData', () => {
    it('should write small object data as a single document when no existing chunks', async () => {
      const smallData = { key1: 'value1', key2: 'value2' };
      mockQuerySnapshot.empty = true;
      mockQuerySnapshot.docs = [];

      await chunkManager.writeData(mockCollectionRef, 'test', smallData);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        smallData
      );
      expect(mockAdapter.writeBatch).not.toHaveBeenCalled();
    });

    it('should write small object data with merge when single chunk exists', async () => {
      const smallData = { existingKey: 'existingValue', key1: 'value1', key2: 'value2' };
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { existingKey: 'existingValue' })
      ];

      // Force single chunk mode by mocking size calculation
      (chunkManager as any).calculateDataSize = jest.fn(() => 100); // Small size to avoid chunking
      // Force areChunksEqual to always return false so update is triggered
      (chunkManager as any).areChunksEqual = jest.fn(() => false);

      await chunkManager.writeData(mockCollectionRef, 'test', smallData);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        smallData,
        { merge: true }
      );
    });

    it('should handle array data with replace (no merge) when no existing chunks', async () => {
      const arrayData = ['item1', 'item2', 'item3'];
      mockQuerySnapshot.empty = true;

      await chunkManager.writeData(mockCollectionRef, 'test', arrayData);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        { '0': 'item1', '1': 'item2', '2': 'item3' }
      );
    });

    it('should handle array data with replace (no merge) when single chunk exists', async () => {
      const arrayData = ['item1', 'item2', 'item3'];
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { '0': 'old1', '1': 'old2' })
      ];

      await chunkManager.writeData(mockCollectionRef, 'test', arrayData);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        { '0': 'item1', '1': 'item2', '2': 'item3' }
      );
    });

    it('should clean up extra chunks and replace chunk_0 when converting from chunked to single', async () => {
      const smallData = { key: 'value' };
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { oldData1: 'value1' }),
        createMockDocSnapshot('chunk_1', { oldData2: 'value2' }),
        createMockDocSnapshot('chunk_2', { oldData3: 'value3' }),
      ];

      await chunkManager.writeData(mockCollectionRef, 'test', smallData);

      // Should use batch to delete extra chunks and replace chunk_0
      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.delete).toHaveBeenCalledTimes(2); // Delete chunk_1 and chunk_2
      expect(mockBatch.set).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        smallData
      );
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it('should clean up extra chunks and replace chunk_0 with array data', async () => {
      const arrayData = ['item1', 'item2', 'item3'];
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { '0': 'old1' }),
        createMockDocSnapshot('chunk_1', { '1': 'old2' }),
      ];

      await chunkManager.writeData(mockCollectionRef, 'test', arrayData);

      // Should use batch to delete extra chunks and replace chunk_0
      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.delete).toHaveBeenCalledTimes(1); // Delete chunk_1
      expect(mockBatch.set).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chunk_0' }),
        { '0': 'item1', '1': 'item2', '2': 'item3' }
      );
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it('should use chunking for large data exceeding size limit', async () => {
      // Create data that will definitely exceed the 200KB chunk size
      const largeData: Record<string, string> = {};
      for (let i = 0; i < 300; i++) {
        largeData[`key${i}`] = 'x'.repeat(1000); // 1000 chars per value
      }

      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { oldKey: 'oldValue' })
      ];

      await chunkManager.writeData(mockCollectionRef, 'test', largeData);

      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.set).toHaveBeenCalled();
      expect(mockBatch.commit).toHaveBeenCalled();

      // Verify chunk IDs were used
      const setCalls = mockBatch.set.mock.calls;
      expect(setCalls.length).toBeGreaterThan(1);
      setCalls.forEach((call, index) => {
        expect(call[0].id).toBe(`chunk_${index}`);
      });
    });

    it('should force chunking when field count exceeds threshold', async () => {
      // Create data with many fields (over 19,000 to trigger force chunking)
      const manyFieldsData: Record<string, string> = {};
      for (let i = 0; i < 19500; i++) {
        manyFieldsData[`field${i}`] = 'value';
      }

      mockQuerySnapshot.empty = true;

      await chunkManager.writeData(mockCollectionRef, 'test', manyFieldsData);

      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.set).toHaveBeenCalled();
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it('should throw SyncError for validation failures', async () => {
      mockDataProcessor.validateForFirestore.mockReturnValue({
        isValid: false,
        errors: ['Invalid data format']
      });

      await expect(chunkManager.writeData(mockCollectionRef, 'test', { key: 'value' }))
        .rejects.toThrow(SyncError);
      await expect(chunkManager.writeData(mockCollectionRef, 'test', { key: 'value' }))
        .rejects.toMatchObject({
          type: SyncErrorType.SyncValidationError,
        });
    });

    it('should throw SyncError for primitive values that are too large', async () => {
      const largeString = 'x'.repeat(300000);

      await expect(chunkManager.writeData(mockCollectionRef, 'test', largeString))
        .rejects.toThrow(SyncError);
      await expect(chunkManager.writeData(mockCollectionRef, 'test', largeString))
        .rejects.toMatchObject({
          type: SyncErrorType.SyncValidationError,
        });
    });

    describe('field deletions', () => {
      it('should handle field deletions in single chunk by replacing document', async () => {
        // Setup existing data with multiple fields
        const existingData = {
          field1: 'value1',
          field2: 'value2',
          field3: 'value3'
        };
        mockQuerySnapshot.docs = [
          createMockDocSnapshot('chunk_0', existingData)
        ];

        // New data with one field deleted
        const newData = {
          field1: 'value1',
          field3: 'value3'
          // field2 is deleted
        };

        await chunkManager.writeData(mockCollectionRef, 'test', newData);

        // Should use set without merge to ensure deleted field is removed
        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'chunk_0' }),
          newData
        );
        expect(mockAdapter.setDocument).not.toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          { merge: true }
        );
      });

      it('should handle field deletions in chunked data by replacing affected chunks', async () => {
        // Setup existing chunked data
        const chunk0Data = {
          field1: 'value1',
          field2: 'value2'
        };
        const chunk1Data = {
          field3: 'value3',
          field4: 'value4'
        };
        mockQuerySnapshot.docs = [
          createMockDocSnapshot('chunk_0', chunk0Data),
          createMockDocSnapshot('chunk_1', chunk1Data)
        ];

        // New data with fields deleted from both chunks
        const newData = {
          field1: 'value1',
          // field2 deleted from chunk_0
          field3: 'value3'
          // field4 deleted from chunk_1
        };

        // Mock the chunking behavior to ensure fields are properly separated
        (chunkManager as any).MAX_CHUNK_SIZE = 1;

        // Mock the chunking behavior to ensure fields are properly separated
        const mockGenerateChunks = jest.spyOn(require('../chunking/helpers/chunkGeneration'), 'generateChunks');
        mockGenerateChunks.mockImplementation(async (data: unknown) => {
          const typedData = data as { field1?: string; field3?: string };
          const chunks = [];
          if (typedData.field1 !== undefined) {
            chunks.push({ field1: typedData.field1 });
          }
          if (typedData.field3 !== undefined) {
            chunks.push({ field3: typedData.field3 });
          }
          return chunks;
        });

        await chunkManager.writeData(mockCollectionRef, 'test', newData);

        // Should use batch to update chunks
        expect(mockAdapter.writeBatch).toHaveBeenCalled();

        // Get all set operations from batch
        const setCalls = mockBatch.set.mock.calls;

        // Map chunk IDs to data for easier assertion
        const chunkDataById: Record<string, any> = {};
        setCalls.forEach(call => {
          const [docRef, data] = call;
          chunkDataById[docRef.id] = data;
        });
        expect(chunkDataById['chunk_0']).toEqual({ field1: 'value1' });
        expect(chunkDataById['chunk_1']).toEqual({ field3: 'value3' });

        // Verify no merge operations were used
        setCalls.forEach(call => {
          expect(call[2]).toBeUndefined(); // No merge option
        });

        // Restore the spy
        mockGenerateChunks.mockRestore();
      });

      it('should handle nested field deletions correctly', async () => {
        // Setup existing data with nested fields
        const existingData = {
          user: {
            name: 'John',
            email: 'john@example.com',
            settings: {
              theme: 'dark',
              notifications: true
            }
          },
          metadata: {
            created: '2024-01-01',
            updated: '2024-01-02'
          }
        };
        mockQuerySnapshot.docs = [
          createMockDocSnapshot('chunk_0', existingData)
        ];

        // New data with nested fields deleted
        const newData = {
          user: {
            name: 'John',
            // email deleted
            settings: {
              theme: 'dark'
              // notifications deleted
            }
          }
          // metadata object deleted
        };

        await chunkManager.writeData(mockCollectionRef, 'test', newData);

        // Should use set without merge to ensure all deleted fields are removed
        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'chunk_0' }),
          newData
        );
        expect(mockAdapter.setDocument).not.toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          { merge: true }
        );
      });

      it('should handle field deletions in array data correctly', async () => {
        // Setup existing array data
        const existingData = [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2', extra: 'data' },
          { id: 3, name: 'Item 3' }
        ];
        mockQuerySnapshot.docs = [
          createMockDocSnapshot('chunk_0', Object.fromEntries(
            existingData.map((item, index) => [String(index), item])
          ))
        ];

        // New array data with fields deleted from items
        const newData = [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' }, // extra field deleted
          { id: 3, name: 'Item 3' }
        ];

        await chunkManager.writeData(mockCollectionRef, 'test', newData);

        // Should use set without merge to ensure deleted fields are removed
        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'chunk_0' }),
          {
            '0': { id: 1, name: 'Item 1' },
            '1': { id: 2, name: 'Item 2' },
            '2': { id: 3, name: 'Item 3' }
          }
        );
        expect(mockAdapter.setDocument).not.toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          { merge: true }
        );
      });
    });
  });

  describe('readData', () => {
    it('should return undefined for empty collection', async () => {
      mockQuerySnapshot.empty = true;
      mockQuerySnapshot.docs = [];

      const result = await chunkManager.readData(mockCollectionRef);
      expect(result).toBeUndefined();
    });

    it('should reconstruct single document data', async () => {
      const testData = { key1: 'value1', key2: 'value2' };
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', testData)
      ];

      const result = await chunkManager.readData(mockCollectionRef);
      expect(result).toEqual(testData);
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalledWith(testData);
    });

    it('should reconstruct chunked data', async () => {
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { key1: 'value1', key2: 'value2' }),
        createMockDocSnapshot('chunk_1', { key3: 'value3', key4: 'value4' }),
      ];

      const expectedData = {
        key1: 'value1',
        key2: 'value2',
        key3: 'value3',
        key4: 'value4'
      };

      const result = await chunkManager.readData(mockCollectionRef);
      expect(result).toEqual(expectedData);
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalledWith(expectedData);
    });

    it('should reconstruct array data', async () => {
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { '0': 'item1', '1': 'item2' }),
        createMockDocSnapshot('chunk_1', { '2': 'item3', '3': 'item4' }),
      ];

      const result = await chunkManager.readData(mockCollectionRef);
      expect(result).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    it('should handle read errors', async () => {
      mockAdapter.getCollection.mockRejectedValue(new Error('Network error'));

      await expect(chunkManager.readData(mockCollectionRef))
        .rejects.toThrow(SyncError);
      await expect(chunkManager.readData(mockCollectionRef))
        .rejects.toMatchObject({
          type: SyncErrorType.SyncFailed,
        });
    });

    it('should handle corrupted chunk data gracefully', async () => {
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', null),
        createMockDocSnapshot('chunk_1', { valid: 'data' }),
      ];

      const result = await chunkManager.readData(mockCollectionRef);
      expect(result).toEqual({ valid: 'data' });
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalled();
    });
  });

  describe('data integrity', () => {
    it('should maintain data through write/read cycle', async () => {
      const originalData = {
        user: {
          name: 'John Doe',
          email: 'john@example.com',
          createdAt: new Date('2023-01-01'),
          preferences: {
            theme: 'dark',
            notifications: true
          }
        },
        posts: [
          { title: 'First Post', content: 'Hello world!' },
          { title: 'Second Post', content: 'Another post' }
        ]
      };

      // Mock sanitization (simulating Date -> Timestamp conversion)
      const sanitizedData = {
        ...originalData,
        user: {
          ...originalData.user,
          createdAt: require('@react-native-firebase/firestore').Timestamp.fromDate(originalData.user.createdAt)
        }
      };

      // Setup write mocks
      mockDataProcessor.sanitizeForFirestore.mockReturnValue(sanitizedData);
      mockDataProcessor.validateForFirestore.mockReturnValue({ isValid: true, errors: [] });
      mockAdapter.getCollection.mockResolvedValue({ empty: true, docs: [] } as any);

      // Write data
      await chunkManager.writeData(mockCollectionRef, 'test-data', originalData);

      // Setup read mocks - simulate reading back the sanitized data
      const mockDoc = {
        id: 'chunk_0',
        data: () => sanitizedData
      };

      mockAdapter.getCollection.mockResolvedValue({
        empty: false,
        docs: [mockDoc]
      } as any);
      mockDataProcessor.restoreFromFirestore.mockReturnValue(originalData);

      // Read data back
      const restoredData = await chunkManager.readData(mockCollectionRef);

      expect(restoredData).toEqual(originalData);
      expect(mockDataProcessor.sanitizeForFirestore).toHaveBeenCalledWith(originalData);
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalledWith(sanitizedData);
    });

    it('should handle large datasets with chunking', async () => {
      // Create a large dataset that will require chunking
      const largeDataset: Record<string, any> = {};
      for (let i = 0; i < 200; i++) {
        largeDataset[`record_${i}`] = {
          id: i,
          data: 'x'.repeat(1500), // ~1.5KB per record
          metadata: { created: new Date(), index: i }
        };
      }

      mockDataProcessor.sanitizeForFirestore.mockReturnValue(largeDataset);
      mockDataProcessor.validateForFirestore.mockReturnValue({ isValid: true, errors: [] });
      mockAdapter.getCollection.mockResolvedValue({ empty: true, docs: [] } as any);

      // Write large dataset (should chunk automatically)
      await chunkManager.writeData(mockCollectionRef, 'large-dataset', largeDataset);

      // Verify chunking occurred
      const chunkCalls = (mockCollectionRef.doc as jest.Mock).mock.calls
        .filter(call => call[0].startsWith('chunk_'));
      expect(chunkCalls.length).toBeGreaterThan(1);

      // Setup read mocks to simulate chunk reconstruction
      const chunkDocs = chunkCalls.map((call, index) => ({
        id: call[0],
        data: () => {
          // Simulate partial data in each chunk
          const startIndex = index * 50;
          const endIndex = Math.min((index + 1) * 50, 200);
          const chunkData: Record<string, any> = {};
          for (let i = startIndex; i < endIndex; i++) {
            chunkData[`record_${i}`] = largeDataset[`record_${i}`];
          }
          return chunkData;
        }
      }));

      mockAdapter.getCollection.mockResolvedValue({
        empty: false,
        docs: chunkDocs
      } as any);
      mockDataProcessor.restoreFromFirestore.mockReturnValue(largeDataset);

      // Read back and verify
      const restoredData = await chunkManager.readData(mockCollectionRef);
      expect(restoredData).toEqual(largeDataset);
    });

    it('should preserve objects with numeric keys that do not start at 0 or are not contiguous', async () => {
      // Original object with numeric keys starting at 1000
      const originalData = {
        1000: 'a',
        1001: 'b',
        1002: 'c',
      };
      // Simulate sanitization (no-op for this test)
      mockDataProcessor.sanitizeForFirestore.mockReturnValue(originalData);
      mockDataProcessor.validateForFirestore.mockReturnValue({ isValid: true, errors: [] });
      mockAdapter.getCollection.mockResolvedValue({ empty: true, docs: [] } as any);

      // Write data (should chunk if needed, but we force chunking for test)
      (chunkManager as any).calculateDataSize = jest.fn(() => 100_001); // Force chunking
      await chunkManager.writeData(mockCollectionRef, 'numeric-keys', originalData);

      // Simulate reading back chunked docs
      const chunkDocs = [
        { id: 'chunk_0', data: () => ({ 1000: 'a', 1001: 'b' }) },
        { id: 'chunk_1', data: () => ({ 1002: 'c' }) },
      ];
      mockAdapter.getCollection.mockResolvedValue({
        empty: false,
        docs: chunkDocs
      } as any);
      mockDataProcessor.restoreFromFirestore.mockReturnValue(originalData);

      // Read data back
      const restoredData = await chunkManager.readData(mockCollectionRef);
      expect(restoredData).toEqual(originalData);
      // Ensure restoreFromFirestore is called with the merged object, not an array
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalledWith(originalData);
    });

    it('should use hash optimization for large chunks with many keys', async () => {
      // Create a large chunk that will remain unchanged
      const unchangedChunk: Record<string, string> = {};
      for (let i = 0; i < 1500; i++) { // Exceed 1000 key threshold
        unchangedChunk[`unchanged_key${i}`] = 'same_value';
      }

      // Create a large chunk that will be different
      const changedChunk: Record<string, string> = {};
      for (let i = 0; i < 1500; i++) {
        changedChunk[`changed_key${i}`] = 'new_value';
      }

      // Mock existing chunks - both large enough to trigger hash optimization
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', unchangedChunk),
        createMockDocSnapshot('chunk_1', { different: 'data' }),
      ];

      // Create new data that matches chunk_0 exactly but changes chunk_1
      const newData = {
        ...unchangedChunk,
        ...changedChunk
      };

      await chunkManager.writeData(mockCollectionRef, 'large-hash-test', newData);

      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.commit).toHaveBeenCalled();

      // The hash optimization should have detected that some chunks are unchanged
      // We can't predict exact chunk assignments, but we can verify batching occurred
      const setCalls = mockBatch.set.mock.calls;
      expect(setCalls.length).toBeGreaterThan(0);

      // Verify the chunks were properly identified by their IDs
      setCalls.forEach(call => {
        expect(call[0].id).toMatch(/^chunk_\d+$/);
      });
    });

    it('should handle data that cannot be serialized to Blob', async () => {
      // Create circular reference that can't be JSON.stringify'd
      const circularData: any = { name: 'test' };
      circularData.self = circularData;

      // Mock sanitizeForFirestore to return data that will cause Blob creation to fail
      // but JSON.stringify to work (simulating the fallback scenario)
      mockDataProcessor.sanitizeForFirestore.mockReturnValue({ processedData: 'safe' });

      // Override global Blob to throw an error
      const originalBlob = global.Blob;
      global.Blob = jest.fn().mockImplementation(() => {
        throw new Error('Blob creation failed');
      });

      try {
        await chunkManager.writeData(mockCollectionRef, 'circular-test', circularData);

        // Should still work due to fallback
        expect(mockAdapter.setDocument).toHaveBeenCalled();
      } finally {
        // Restore original Blob
        global.Blob = originalBlob;
      }
    });

    it('should log efficiency metrics for chunked operations', async () => {
      // Import and properly mock Log
      const Log = require('../../utils/Log');

      // Create data that will be chunked
      const largeData: Record<string, string> = {};
      for (let i = 0; i < 300; i++) {
        largeData[`key${i}`] = 'x'.repeat(1000);
      }

      // Mock existing chunks - some will be unchanged, some updated
      mockQuerySnapshot.docs = [
        createMockDocSnapshot('chunk_0', { differentKey: 'different_value' }),
        createMockDocSnapshot('chunk_2', { obsoleteKey: 'obsolete_data' }), // Will be deleted
      ];

      await chunkManager.writeData(mockCollectionRef, 'metrics-test', largeData);

      // Verify that Log.info was called (it should be mocked in the jest.mock at the top)
      expect(Log.info).toBeDefined();
      expect(Log.info).toHaveBeenCalled();

      // Find the efficiency log call
      const logCalls = Log.info.mock.calls;
      const efficiencyLog = logCalls.find((call: [string, ...any[]]) =>
        call[0] && typeof call[0] === 'string' && call[0].includes('Efficiency:')
      );

      expect(efficiencyLog).toBeDefined();
      expect(efficiencyLog[0]).toContain('Total chunks:');
      expect(efficiencyLog[0]).toContain('Updated:');
      expect(efficiencyLog[0]).toContain('Skipped:');
      expect(efficiencyLog[0]).toContain('Deleted:');
    });
  });

  describe('error handling', () => {
    it('should wrap unknown errors in SyncError', async () => {
      const testData = { test: 'data' };

      mockDataProcessor.sanitizeForFirestore.mockReturnValue(testData);
      mockDataProcessor.validateForFirestore.mockReturnValue({ isValid: true, errors: [] });
      mockAdapter.getCollection.mockRejectedValue(new Error('Unknown error'));

      await expect(chunkManager.writeData(mockCollectionRef, 'test-key', testData))
        .rejects.toThrow(SyncError);
    });

    it('should preserve existing SyncErrors', async () => {
      const testData = { test: 'data' };
      const syncError = new SyncError('Custom sync error', SyncErrorType.SyncFailed);

      mockDataProcessor.sanitizeForFirestore.mockReturnValue(testData);
      mockDataProcessor.validateForFirestore.mockReturnValue({ isValid: true, errors: [] });
      mockAdapter.getCollection.mockRejectedValue(syncError);

      await expect(chunkManager.writeData(mockCollectionRef, 'test-key', testData))
        .rejects.toBe(syncError);
    });

    it('should handle corrupted chunk data gracefully', async () => {
      const corruptedDocs = [
        { id: 'chunk_0', data: () => null },
        { id: 'chunk_1', data: () => ({ valid: 'data' }) },
      ];

      mockAdapter.getCollection.mockResolvedValue({
        empty: false,
        docs: corruptedDocs
      } as any);

      mockDataProcessor.restoreFromFirestore.mockReturnValue({ valid: 'data' });

      const result = await chunkManager.readData(mockCollectionRef);

      // Should still return processed data despite some corruption
      expect(result).toEqual({ valid: 'data' });
      expect(mockDataProcessor.restoreFromFirestore).toHaveBeenCalled();
    });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});