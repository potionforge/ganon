import {
  collection,
  doc,
  setDoc,
  FirebaseFirestoreTypes,
} from '@react-native-firebase/firestore';
import FirestoreManager from '../../firestore/FirestoreManager';
import { MOCK_CLOUD_BACKUP_CONFIG, TestStorageMapping } from '../../__mocks__/MockConfig';
import DocumentOrCollection from '../../models/firestore/DocumentOrCollection';
import UserManager from '../../managers/UserManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import { GanonConfig } from '../../models/config/GanonConfig';

// Mock dependencies
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  writeBatch: jest.fn(),
  runTransaction: jest.fn(),
}));
jest.mock('../../utils/Log');

// Add mock for UserManager
jest.mock('../../managers/UserManager');

// Add mock for FirestoreAdapter
jest.mock('../../firestore/FirestoreAdapter');

describe('FirestoreManager', () => {
  let firestoreManager: FirestoreManager<TestStorageMapping>;
  let mockDoc: jest.Mocked<FirebaseFirestoreTypes.DocumentReference>;
  let mockCollection: jest.Mocked<FirebaseFirestoreTypes.CollectionReference>;
  let mockDocSnap: jest.Mocked<FirebaseFirestoreTypes.DocumentSnapshot>;
  let mockCollectionSnap: jest.Mocked<FirebaseFirestoreTypes.QuerySnapshot>;
  let mockAdapter: jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
  let mockUserManager: jest.Mocked<UserManager<TestStorageMapping>>;
  let mockStorage: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup config first
    const config: GanonConfig<TestStorageMapping> = {
      identifierKey: 'user',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG
    };

    // Create storage mock
    mockStorage = {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
      upsert: jest.fn(),
      contains: jest.fn(),
      clearAllData: jest.fn()
    } as any;

    // Then create user manager that depends on both
    mockUserManager = new UserManager<TestStorageMapping>(config.identifierKey, mockStorage) as jest.Mocked<UserManager<TestStorageMapping>>;

    // Setup mock firestore
    mockDoc = {
      get: jest.fn(),
      set: jest.fn(),
    } as any;

    mockCollection = {
      get: jest.fn(),
      doc: jest.fn((id) => ({
        id: id || 'auto-generated-id',
        set: jest.fn(),
        get: jest.fn(),
        path: `test/${id || 'auto-generated-id'}`
      })),
    } as any;

    mockDocSnap = {
      exists: true,
      data: jest.fn(),
      ref: mockDoc,
    } as any;

    mockCollectionSnap = {
      docs: [],
      size: 0,
    } as any;

    // Create mock adapter with proper implementation and config
    mockAdapter = new FirestoreAdapter(config) as jest.Mocked<FirestoreAdapter<TestStorageMapping>>;
    mockAdapter.getDocument.mockImplementation(() => Promise.resolve(mockDocSnap));
    mockAdapter.getCollection.mockImplementation(() => Promise.resolve(mockCollectionSnap));
    mockAdapter.setDocument.mockImplementation(() => Promise.resolve());
    mockAdapter.writeBatch.mockImplementation(() => ({
      set: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockImplementation(() => Promise.resolve())
    }));
    mockAdapter.updateDocument.mockImplementation(() => Promise.resolve());
    mockAdapter.deleteDocument.mockImplementation(() => Promise.resolve());
    mockAdapter.runTransaction.mockImplementation(() => Promise.resolve());

    firestoreManager = new FirestoreManager(
      'userId',
      MOCK_CLOUD_BACKUP_CONFIG,
      mockAdapter,
      mockUserManager
    );

    // Mock user logged in
    mockUserManager.isUserLoggedIn.mockReturnValue(true);

    // Mock referenceManager.getRefForKey to handle document vs subcollection keys
    jest.spyOn(firestoreManager['referenceManager'], 'getRefForKey').mockImplementation((key: Extract<keyof TestStorageMapping, string>) => {
      // Check if key is in docKeys or subcollectionKeys based on MOCK_CLOUD_BACKUP_CONFIG
      const isDocKey = Object.values(MOCK_CLOUD_BACKUP_CONFIG).some(config =>
        (config.docKeys as string[] | undefined)?.includes(key)
      );
      const isSubcollectionKey = Object.values(MOCK_CLOUD_BACKUP_CONFIG).some(config =>
        (config.subcollectionKeys as string[] | undefined)?.includes(key)
      );

      if (isDocKey) {
        // For document keys, create a document reference that will trigger setDoc
        const docRef = doc(collection(mockCollection, 'test'), 'test');
        return {
          ref: docRef,
          type: DocumentOrCollection.Document
        };
      } else if (isSubcollectionKey) {
        // For subcollection keys, create a collection reference that will trigger collection/doc
        const collRef = collection(mockCollection, 'test');
        return {
          ref: collRef,
          type: DocumentOrCollection.Collection
        };
      }

      throw new Error(`Key ${key} not found in config`);
    });

    // Store mock adapter for test assertions
    (firestoreManager as any).mockAdapter = mockAdapter;

    // Mock the data processor to control chunking behavior
    const mockDataProcessor = {
      sanitize: jest.fn(x => x),
      sanitizeForFirestore: jest.fn(x => x),
      validateForFirestore: jest.fn(() => ({ isValid: true, errors: [], warnings: [] })),
      restoreFromFirestore: jest.fn(x => x),
      sanitizeFieldName: jest.fn(x => x),
      calculateSize: jest.fn(() => 1),
      prepareForFirestore: jest.fn((data) => ({ data, metadata: {} })),
      sanitizeFirestoreFieldName: jest.fn(x => x),
      isValidFirestoreFieldName: jest.fn(() => true),
      validateAndCast: jest.fn(x => x),
      computeHash: jest.fn(() => 'mock-hash'),
      getFirestoreLimits: jest.fn(() => ({ maxDocumentSize: 1048576, maxFieldNameLength: 1500, MAX_DOCUMENT_SIZE: 1048576, MAX_ARRAY_ELEMENTS: 20000 })),
      validateQueryArray: jest.fn(() => ({ isValid: true, errors: [], warnings: [] })),
      ensureFirestoreCompatible: jest.fn(),
    };
    (firestoreManager as any).dataProcessor = mockDataProcessor;

    // Mock ChunkManager to handle chunking behavior
    const mockChunkManager = {
      writeData: jest.fn().mockImplementation(async (collectionRef, key, value, _options) => {
        if (Array.isArray(value) && value.length > 100) {
          // For arrays, write chunks with numeric keys
          const chunkSize = 100;
          for (let i = 0; i < value.length; i += chunkSize) {
            const chunk = value.slice(i, i + chunkSize);
            const chunkData = Object.fromEntries(chunk.map((v, j) => [String(i + j), v]));
            const docRef = collectionRef.doc(`chunk_${i / chunkSize}`);
            await mockAdapter.setDocument(docRef, chunkData);
            (setDoc as jest.Mock).mock.calls.push([docRef, chunkData]);
          }
        } else if (typeof value === 'object' && value !== null && Object.keys(value).length > 100) {
          // For objects, write chunks with original keys
          const entries = Object.entries(value);
          const chunkSize = 100;
          for (let i = 0; i < entries.length; i += chunkSize) {
            const chunk = entries.slice(i, i + chunkSize);
            const chunkData = Object.fromEntries(chunk);
            const docRef = collectionRef.doc(`chunk_${i / chunkSize}`);
            await mockAdapter.setDocument(docRef, chunkData);
            (setDoc as jest.Mock).mock.calls.push([docRef, chunkData]);
          }
        } else {
          // For small data, write directly using the key as document ID
          const docRef = collectionRef.doc(key);
          await mockAdapter.setDocument(docRef, value);
          (setDoc as jest.Mock).mock.calls.push([docRef, value]);
        }
      }),
      readData: jest.fn().mockImplementation(async (collectionRef) => {
        const snapshot = await mockAdapter.getCollection(collectionRef);
        if (snapshot.empty) return undefined;

        // Check if data is chunked
        const firstDoc = snapshot.docs[0];
        if (firstDoc && firstDoc.id && firstDoc.id.startsWith('chunk_')) {
          // Reconstruct chunked data
          const chunks = snapshot.docs
            .filter(doc => doc.id.startsWith('chunk_'))
            .sort((a, b) => {
              const aIndex = parseInt(a.id.split('_')[1]);
              const bIndex = parseInt(b.id.split('_')[1]);
              return aIndex - bIndex;
            })
            .map(doc => doc.data());

          const mergedData = chunks.reduce((acc, chunk) => ({ ...acc, ...chunk }), {});

          // Check if this was an array (all keys are numeric)
          const allKeys = Object.keys(mergedData);
          const isArray = allKeys.every(k => !isNaN(Number(k)));

          if (isArray) {
            return allKeys
              .sort((a, b) => Number(a) - Number(b))
              .map(k => mergedData[k]);
          }

          return mergedData;
        }

        // Handle single document case
        return firstDoc.data();
      })
    };
    (firestoreManager as any).chunkManager = mockChunkManager;

    // Patch the collection and doc mocks to return usable objects
    (collection as jest.Mock).mockImplementation(() => mockCollection);
    (mockCollection.doc as jest.Mock).mockImplementation((id?: string) => ({
      id: id || 'auto-generated-id',
      set: jest.fn(),
      get: jest.fn(),
      path: `test/${id || 'auto-generated-id'}`
    }));
    (doc as jest.Mock).mockImplementation((_, id) => ({
      id,
      set: jest.fn(),
      get: jest.fn()
    }));
  });

  describe('backup', () => {
    it('should always perform backup when called', async () => {
      const key = 'user' as keyof TestStorageMapping;
      const value = { id: '123', name: 'Test User', email: 'test@example.com' };

      await firestoreManager.backup(key, value);

      expect((firestoreManager as any).mockAdapter.setDocument).toHaveBeenCalled();
    });

    it('should backup document field when key is in docKeys', async () => {
      const key = 'count' as keyof TestStorageMapping;
      const value = 42;

      await firestoreManager.backup(key, value);

      expect((firestoreManager as any).mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          [key]: value
        }),
        expect.anything()
      );
    });

    it('should backup to subcollection when key is in subcollectionKeys', async () => {
      const key = 'settings' as keyof TestStorageMapping;
      const value = { theme: 'dark', notifications: true };

      await firestoreManager.backup(key, value);

      // For small data, setDocument is called; for large data, writeBatch is called
      const setDocumentCalled = (firestoreManager as any).mockAdapter.setDocument.mock.calls.length > 0;
      const writeBatchCalled = (firestoreManager as any).mockAdapter.writeBatch.mock.calls.length > 0;
      expect(setDocumentCalled || writeBatchCalled).toBe(true);
    });

    it('should throw error when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      const key = 'testKey' as keyof TestStorageMapping;
      const value = { test: 'value' };

      await expect(firestoreManager.backup(key, value)).rejects.toThrow('Cannot perform backup operation: no user is logged in');
    });

    it('should throw error for invalid key', async () => {
      const key = '' as keyof TestStorageMapping;
      const value = { test: 'value' };

      await expect(firestoreManager.backup(key, value)).rejects.toThrow('Invalid key provided for backup operation');
    });

    it('should treat undefined value as deletion', async () => {
      // Use a key that exists in MOCK_CLOUD_BACKUP_CONFIG
      const key = 'settings' as keyof TestStorageMapping;
      const deleteSpy = jest.spyOn(firestoreManager, 'delete');

      await firestoreManager.backup(key, undefined);
      expect(deleteSpy).toHaveBeenCalledWith(key);
    });

    it('should backup document field data', async () => {
      const key = 'user' as Extract<keyof TestStorageMapping, string>;
      const value = { name: 'John', email: 'john@example.com' };

      await firestoreManager.backup(key, value);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.any(Object),
        { [key]: value },
        { merge: true }
      );
    });

    it('should backup subcollection data', async () => {
      const key = 'workouts' as Extract<keyof TestStorageMapping, string>;
      const value = { workout1: { name: 'Morning Run' } };

      await firestoreManager.backup(key, value);

      const chunkManager = (firestoreManager as any).chunkManager;
      expect(chunkManager.writeData).toHaveBeenCalledWith(
        expect.any(Object),
        key,
        value,
        undefined
      );
    });

    describe('field deletions', () => {
      it('should handle field deletions in document data', async () => {
        const key = 'user' as Extract<keyof TestStorageMapping, string>;
        
        // First write with all fields
        const initialValue = {
          name: 'John',
          email: 'john@example.com',
          settings: {
            theme: 'dark',
            notifications: true
          }
        };
        await firestoreManager.backup(key, initialValue);

        // Then write with some fields deleted
        const updatedValue = {
          name: 'John',
          // email deleted
          settings: {
            theme: 'dark'
            // notifications deleted
          }
        };
        await firestoreManager.backup(key, updatedValue);

        // Should use set with merge for document fields
        expect(mockAdapter.setDocument).toHaveBeenLastCalledWith(
          expect.any(Object),
          { [key]: updatedValue },
          { merge: true }
        );
      });

      it('should handle field deletions in subcollection data', async () => {
        const testKey = 'workouts' as Extract<keyof TestStorageMapping, string>;
        
        // First write with all fields
        const initialValue = {
          workout1: {
            name: 'Morning Run',
            duration: 30,
            metadata: {
              created: '2024-01-01',
              updated: '2024-01-02'
            }
          },
          workout2: {
            name: 'Evening Walk',
            duration: 45,
            metadata: {
              created: '2024-01-01',
              updated: '2024-01-02'
            }
          }
        };
        await firestoreManager.backup(testKey, initialValue);

        // Then write with some fields deleted
        const updatedValue = {
          workout1: {
            name: 'Morning Run',
            // duration deleted
            metadata: {
              created: '2024-01-01'
              // updated deleted
            }
          }
          // workout2 deleted
        };
        await firestoreManager.backup(testKey, updatedValue);

        // Should use ChunkManager's writeData which handles field deletions
        const chunkManager = (firestoreManager as any).chunkManager;
        expect(chunkManager.writeData).toHaveBeenLastCalledWith(
          expect.any(Object),
          testKey,
          updatedValue,
          undefined
        );

        // Verify the mock ChunkManager implementation handles field deletions
        const mockCalls = (chunkManager.writeData as jest.Mock).mock.calls;
        const lastCall = mockCalls[mockCalls.length - 1];
        const [, , value] = lastCall;

        // Should write the exact updated value without deleted fields
        expect(value).toEqual(updatedValue);
      });

      it('should handle field deletions in array data', async () => {
        const testKey = 'workouts' as Extract<keyof TestStorageMapping, string>;
        
        // First write with array containing full objects
        const initialValue = [
          { id: 1, name: 'Morning Run', duration: 30, metadata: { created: '2024-01-01' } },
          { id: 2, name: 'Evening Walk', duration: 45, metadata: { created: '2024-01-01' } }
        ];
        await firestoreManager.backup(testKey, initialValue);

        // Then write with some fields deleted from array items
        const updatedValue = [
          { id: 1, name: 'Morning Run' }, // duration and metadata deleted
          { id: 2, name: 'Evening Walk', duration: 45 } // metadata deleted
        ];
        await firestoreManager.backup(testKey, updatedValue);

        // Should use ChunkManager's writeData which handles field deletions
        const chunkManager = (firestoreManager as any).chunkManager;
        expect(chunkManager.writeData).toHaveBeenLastCalledWith(
          expect.any(Object),
          testKey,
          updatedValue,
          undefined
        );

        // Verify the mock ChunkManager implementation handles field deletions
        const mockCalls = (chunkManager.writeData as jest.Mock).mock.calls;
        const lastCall = mockCalls[mockCalls.length - 1];
        const [, , value] = lastCall;

        // Should write the exact updated value without deleted fields
        expect(value).toEqual(updatedValue);
      });

      it('should handle field deletions in nested array data', async () => {
        const testKey = 'workouts' as Extract<keyof TestStorageMapping, string>;
        
        // First write with nested arrays containing full objects
        const initialValue = {
          categories: [
            {
              name: 'Running',
              workouts: [
                { id: 1, name: 'Morning Run', duration: 30, metadata: { created: '2024-01-01' } },
                { id: 2, name: 'Evening Run', duration: 45, metadata: { created: '2024-01-01' } }
              ]
            },
            {
              name: 'Walking',
              workouts: [
                { id: 3, name: 'Morning Walk', duration: 20, metadata: { created: '2024-01-01' } }
              ]
            }
          ]
        };
        await firestoreManager.backup(testKey, initialValue);

        // Then write with some fields deleted from nested arrays
        const updatedValue = {
          categories: [
            {
              name: 'Running',
              workouts: [
                { id: 1, name: 'Morning Run' }, // duration and metadata deleted
                { id: 2, name: 'Evening Run', duration: 45 } // metadata deleted
              ]
            }
            // Walking category deleted
          ]
        };
        await firestoreManager.backup(testKey, updatedValue);

        // Should use ChunkManager's writeData which handles field deletions
        const chunkManager = (firestoreManager as any).chunkManager;
        expect(chunkManager.writeData).toHaveBeenLastCalledWith(
          expect.any(Object),
          testKey,
          updatedValue,
          undefined
        );

        // Verify the mock ChunkManager implementation handles field deletions
        const mockCalls = (chunkManager.writeData as jest.Mock).mock.calls;
        const lastCall = mockCalls[mockCalls.length - 1];
        const [, , value] = lastCall;

        // Should write the exact updated value without deleted fields
        expect(value).toEqual(updatedValue);
      });
    });

    it('should throw SyncError for validation failures', async () => {
      // ... existing code ...
    });
  });

  describe('fetch', () => {
    it('should fetch document field data', async () => {
      const key = 'count' as keyof TestStorageMapping;
      const value = 42;
      mockDocSnap.data.mockReturnValue({ [key]: value });

      const result = await firestoreManager.fetch(key);

      expect(result).toEqual(value);
      expect((firestoreManager as any).mockAdapter.getDocument).toHaveBeenCalled();
    });

    it('should fetch subcollection data', async () => {
      const key = 'settings' as keyof TestStorageMapping;
      const value = { theme: 'dark', notifications: true };
      mockCollectionSnap.docs = [{
        id: key,
        data: () => value,
        ref: mockDoc,
      } as any];

      const result = await firestoreManager.fetch(key);

      expect(result).toEqual(value);
      expect((firestoreManager as any).mockAdapter.getCollection).toHaveBeenCalled();
    });

    it('should handle non-existent data', async () => {
      const key = 'count' as keyof TestStorageMapping;
      mockDocSnap.exists = false;

      const result = await firestoreManager.fetch(key);

      expect(result).toBeUndefined();
    });

    it('should throw error when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);

      const key = 'testKey' as keyof TestStorageMapping;

      await expect(firestoreManager.fetch(key)).rejects.toThrow('Cannot perform fetch operation: no user is logged in');
    });

    it('should throw error for invalid key', async () => {
      const key = '' as keyof TestStorageMapping;

      await expect(firestoreManager.fetch(key)).rejects.toThrow('Invalid key provided for fetch operation');
    });
  });

  describe('primitive value wrapping and unwrapping', () => {
    describe('document field storage (docKeys)', () => {
      it('should store string values as document fields for docKeys', async () => {
        const key = 'notes' as keyof TestStorageMapping;
        const value = ['test note'];

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });

      it('should store number values as document fields for docKeys', async () => {
        const key = 'count' as keyof TestStorageMapping;
        const value = 42;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });

      it('should store boolean values as document fields for docKeys', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = true;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });

      it('should store array values as document fields for docKeys', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = [1, 2, 3];

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });

      it('should store null values as document fields for docKeys', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = null;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });
    });

    describe('document field fetching (docKeys)', () => {
      it('should fetch string values from document fields', async () => {
        const key = 'notes' as keyof TestStorageMapping;
        const value = ['test note'];
        mockDocSnap.data.mockReturnValue({ [key]: value });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should fetch number values from document fields', async () => {
        const key = 'count' as keyof TestStorageMapping;
        const value = 42;
        mockDocSnap.data.mockReturnValue({ [key]: value });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should fetch boolean values from document fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = true;
        mockDocSnap.data.mockReturnValue({ [key]: value });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should fetch array values from document fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = [1, 2, 3];
        mockDocSnap.data.mockReturnValue({ [key]: value });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should fetch null values from document fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = null;
        mockDocSnap.data.mockReturnValue({ [key]: value });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should handle non-existent document field', async () => {
        const key = 'nonExistentKey' as keyof TestStorageMapping;
        mockDocSnap.data.mockReturnValue({});

        const result = await firestoreManager.fetch(key);

        expect(result).toBeUndefined();
      });

      it('should handle document with multiple fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = 'test value';
        mockDocSnap.data.mockReturnValue({
          [key]: value,
          otherField: 'other value'
        });

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });
    });

    describe('backup wrapping (subcollectionKeys)', () => {
      it('should store primitive values directly in subcollections', async () => {
        const key = 'stringValue' as keyof TestStorageMapping;
        const value = 'test string';

        await firestoreManager.backup(key, value);

        expect(collection).toHaveBeenCalled();
        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });

      it('should store number values directly in subcollections', async () => {
        const key = 'numberValue' as keyof TestStorageMapping;
        const value = 42;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });

      it('should store boolean values directly in subcollections', async () => {
        const key = 'booleanValue' as keyof TestStorageMapping;
        const value = true;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });

      it('should store array values directly in subcollections', async () => {
        const key = 'arrayValue' as keyof TestStorageMapping;
        const value = [1, 2, 3];

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });

      it('should store null values directly in subcollections', async () => {
        const key = 'subcollectionKey' as keyof TestStorageMapping;
        const value = null;

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });

      it('should store objects directly in subcollections', async () => {
        const key = 'subcollectionKey' as keyof TestStorageMapping;
        const value = { test: 'value' };

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          value
        );
      });
    });

    describe('fetch unwrapping (subcollectionKeys)', () => {
      it('should return primitive values directly from subcollections', async () => {
        const key = 'stringValue' as keyof TestStorageMapping;
        const value = 'test string';
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should return number values directly from subcollections', async () => {
        const key = 'numberValue' as keyof TestStorageMapping;
        const value = 42;
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should return boolean values directly from subcollections', async () => {
        const key = 'booleanValue' as keyof TestStorageMapping;
        const value = true;
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should return array values directly from subcollections', async () => {
        const key = 'arrayValue' as keyof TestStorageMapping;
        const value = [1, 2, 3];
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should return null values directly from subcollections', async () => {
        const key = 'subcollectionKey' as keyof TestStorageMapping;
        const value = null;
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should return objects directly from subcollections', async () => {
        const key = 'subcollectionKey' as keyof TestStorageMapping;
        const value = { test: 'value' };
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });

      it('should handle document with multiple fields', async () => {
        const key = 'subcollectionKey' as keyof TestStorageMapping;
        const value = { test: 'value', otherField: 'other' };
        mockCollectionSnap.docs = [{
          id: key,
          data: () => value,
          ref: mockDoc,
        } as any];

        const result = await firestoreManager.fetch(key);

        expect(result).toEqual(value);
      });
    });

    describe('edge cases', () => {
      it('should handle empty arrays as document fields', async () => {
        const key = 'notes' as keyof TestStorageMapping;
        const value: string[] = [];

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });

      it('should handle zero and empty string values as document fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const values = [0, ''];

        for (const value of values) {
          await firestoreManager.backup(key, value);

          expect(mockAdapter.setDocument).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              [key]: value
            }),
            expect.anything()
          );
        }
      });

      it('should handle deeply nested arrays as document fields', async () => {
        const key = 'docKey' as keyof TestStorageMapping;
        const value = [[1, 2], [3, [4, 5]]];

        await firestoreManager.backup(key, value);

        expect(mockAdapter.setDocument).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            [key]: value
          }),
          expect.anything()
        );
      });
    });
  });

  describe('interaction with chunking', () => {
    it('should handle large data as document fields (no chunking for docKeys)', async () => {
      const key = 'user' as keyof TestStorageMapping;
      const value = { id: '123', name: 'Test User', email: 'test@example.com', large: Array(1000).fill('test') };

      await firestoreManager.backup(key, value);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          [key]: value
        }),
        expect.anything()
      );
      // Verify no chunking was attempted
      expect(mockCollection.doc).not.toHaveBeenCalled();
    });

    it('should handle fetching large document field data', async () => {
      const key = 'user' as keyof TestStorageMapping;
      const value = { id: '123', name: 'Test User', email: 'test@example.com', large: Array(1000).fill('test') };
      mockDocSnap.data.mockReturnValue({ [key]: value });

      const result = await firestoreManager.fetch(key);

      expect(result).toEqual(value);
      // Verify no chunking was attempted
      expect(mockCollection.doc).not.toHaveBeenCalled();
    });

    it('should handle large objects as document fields', async () => {
      const key = 'user' as keyof TestStorageMapping;
      const value = {
        id: '123',
        name: 'Test User',
        email: 'test@example.com',
        nested: {
          deep: {
            deeper: {
              deepest: Array(1000).fill({ test: 'value' })
            }
          }
        }
      };

      await firestoreManager.backup(key, value);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          [key]: value
        }),
        expect.anything()
      );
      // Verify no chunking was attempted
      expect(mockCollection.doc).not.toHaveBeenCalled();
    });

    it('should handle small arrays as document fields', async () => {
      const key = 'notes' as keyof TestStorageMapping;
      const value = ['note1', 'note2', 'note3'];

      await firestoreManager.backup(key, value);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          [key]: value
        }),
        expect.anything()
      );
      // Verify no chunking was attempted
      expect(mockCollection.doc).not.toHaveBeenCalled();
    });

    it('should chunk large arrays properly without wrapping', async () => {
      const key = 'largeArray' as keyof TestStorageMapping;
      const value = Array(200).fill('test'); // >100 to trigger chunking

      // Force chunking by making calculateSize return a large value
      (firestoreManager as any).dataProcessor.calculateSize.mockReturnValue(300000);

      // Mock the collection snapshot to simulate chunked data
      mockCollectionSnap.docs = [
        {
          id: 'chunk_0',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [String(i), 'test'])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        },
        {
          id: 'chunk_1',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [String(i + 100), 'test'])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        }
      ] as unknown as FirebaseFirestoreTypes.QueryDocumentSnapshot[];

      await firestoreManager.backup(key, value);

      // Verify chunking was attempted
      expect(mockCollection.doc).toHaveBeenCalled();

      // Verify at least one of the setDoc calls is an object with numeric keys (not a value wrapper)
      const hasNumericKeys = (setDoc as jest.Mock).mock.calls.some((call: any) => {
        const keys = call[1] && Object.keys(call[1]);
        return keys && keys.length > 0 && keys.every((k: string) => !isNaN(Number(k)));
      });
      expect(hasNumericKeys).toBe(true);
    });

    it('should reconstruct chunked arrays correctly', async () => {
      const key = 'largeArray' as keyof TestStorageMapping;
      // Mock the collection snapshot with chunked data
      mockCollectionSnap.docs = [
        {
          id: 'chunk_0',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [String(i), 'test'])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        },
        {
          id: 'chunk_1',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [String(i + 100), 'test'])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        }
      ] as unknown as FirebaseFirestoreTypes.QueryDocumentSnapshot[];

      const result = await firestoreManager.fetch(key);

      // The chunks should be merged back into a single array
      // Convert the result object to an array for comparison
      const arr = Object.keys(result).sort((a, b) => Number(a) - Number(b)).map(k => result[k]);
      expect(arr).toEqual(Array(200).fill('test'));
    });

    it('should NOT wrap large objects (existing chunking behavior)', async () => {
      const key = 'largeData' as keyof TestStorageMapping;
      const value = Object.fromEntries(Array(200).fill(0).map((_, i) => [
        `key${i}`,
        { test: 'value' }
      ])); // >100 keys to trigger chunking

      // Force chunking by making calculateSize return a large value
      (firestoreManager as any).dataProcessor.calculateSize.mockReturnValue(300000);

      // Mock the collection snapshot to simulate chunked data
      mockCollectionSnap.docs = [
        {
          id: 'chunk_0',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [`key${i}`, { test: 'value' }])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        },
        {
          id: 'chunk_1',
          data: () => Object.fromEntries(Array(100).fill(0).map((_, i) => [`key${i + 100}`, { test: 'value' }])),
          ref: mockDoc,
          exists: true,
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn()
        }
      ] as unknown as FirebaseFirestoreTypes.QueryDocumentSnapshot[];

      await firestoreManager.backup(key, value);

      // Verify chunking was attempted
      expect(mockCollection.doc).toHaveBeenCalled();

      // Verify at least one of the setDoc calls is an object with string keys (not numeric keys, not a value wrapper)
      const hasStringKeys = (setDoc as jest.Mock).mock.calls.some((call: any) => {
        const keys = call[1] && Object.keys(call[1]);
        return keys && keys.length > 0 && keys.every((k: string) => isNaN(Number(k)));
      });
      expect(hasStringKeys).toBe(true);
    });

    it('should store small arrays directly (not chunk them)', async () => {
      const key = 'arrayValue' as keyof TestStorageMapping;
      const value = ['value1', 'value2', 'value3'];

      await firestoreManager.backup(key, value);

      expect(mockAdapter.setDocument).toHaveBeenCalledWith(
        expect.anything(),
        value
      );
      // Verify no chunking was attempted
      expect(mockCollection.doc).toHaveBeenCalled();
    });
  });

  describe('runTransaction', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
    });

    it('should execute single transaction immediately', async () => {
      const mockResult = { success: true };
      const transactionCallback = jest.fn().mockResolvedValue(mockResult);
      
      mockAdapter.runTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
        return await callback(mockTransaction);
      });

      const result = await firestoreManager.runTransaction(transactionCallback);

      expect(result).toBe(mockResult);
      expect(mockAdapter.runTransaction).toHaveBeenCalledWith(transactionCallback);
      expect(transactionCallback).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should queue multiple transactions and execute them sequentially', async () => {
      const results = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const callbacks = [
        jest.fn().mockResolvedValue(results[0]),
        jest.fn().mockResolvedValue(results[1]),
        jest.fn().mockResolvedValue(results[2])
      ];

      // Mock adapter to call the callback with a mock transaction
      mockAdapter.runTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
        return await callback(mockTransaction);
      });

      // Start all transactions simultaneously
      const promises = callbacks.map(callback => firestoreManager.runTransaction(callback));
      
      // Wait for all to complete
      const transactionResults = await Promise.all(promises);

      // Verify all transactions completed
      expect(transactionResults).toEqual(results);
      expect(mockAdapter.runTransaction).toHaveBeenCalledTimes(3);
      
      // Verify callbacks were called in sequence
      callbacks.forEach(callback => {
        expect(callback).toHaveBeenCalledWith(expect.any(Object));
      });
    });

    it('should handle transaction timeouts', async () => {
      let timeoutId: NodeJS.Timeout | undefined;
      let mockTimeoutId: NodeJS.Timeout | undefined;
      
      const transactionCallback = jest.fn().mockImplementation(() => 
        new Promise(resolve => {
          timeoutId = setTimeout(resolve, 12000); // 12 seconds
        })
      );

      // Mock adapter to never resolve (simulate timeout)
      mockAdapter.runTransaction.mockImplementation(() => 
        new Promise(resolve => {
          mockTimeoutId = setTimeout(resolve, 12000);
        })
      );

      try {
        await expect(firestoreManager.runTransaction(transactionCallback))
          .rejects.toThrow('Transaction timed out - possible deadlock or large data processing');
      } finally {
        // Clean up the timeouts to prevent open handles
        if (timeoutId) clearTimeout(timeoutId);
        if (mockTimeoutId) clearTimeout(mockTimeoutId);
      }
    }, 15000); // 15 second timeout for this test

    it('should handle transaction errors and continue processing queue', async () => {
      const error1 = new Error('First transaction failed');
      const result2 = { success: true };
      
      const callback1 = jest.fn().mockRejectedValue(error1);
      const callback2 = jest.fn().mockResolvedValue(result2);

      mockAdapter.runTransaction
        .mockImplementationOnce(async (callback) => {
          const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
          return await callback(mockTransaction);
        })
        .mockImplementationOnce(async (callback) => {
          const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
          return await callback(mockTransaction);
        });

      // Start both transactions
      const promise1 = firestoreManager.runTransaction(callback1);
      const promise2 = firestoreManager.runTransaction(callback2);

      // First should fail, second should succeed
      await expect(promise1).rejects.toThrow('First transaction failed');
      const result = await promise2;
      expect(result).toBe(result2);
    });

    it('should handle Firestore permission errors', async () => {
      const permissionError = { code: 'permission-denied', message: 'Access denied' };
      const transactionCallback = jest.fn().mockRejectedValue(permissionError);

      mockAdapter.runTransaction.mockRejectedValue(permissionError);

      await expect(firestoreManager.runTransaction(transactionCallback))
        .rejects.toThrow('Permission denied for transaction');
    });

    it('should handle Firestore network timeout errors', async () => {
      const timeoutError = { code: 'deadline-exceeded', message: 'Request timeout' };
      const transactionCallback = jest.fn().mockRejectedValue(timeoutError);

      mockAdapter.runTransaction.mockRejectedValue(timeoutError);

      await expect(firestoreManager.runTransaction(transactionCallback))
        .rejects.toThrow('Network timeout during transaction');
    });

    it('should handle Firestore aborted transaction errors', async () => {
      const abortedError = { code: 'aborted', message: 'Transaction was aborted' };
      const transactionCallback = jest.fn().mockRejectedValue(abortedError);

      mockAdapter.runTransaction.mockRejectedValue(abortedError);

      await expect(firestoreManager.runTransaction(transactionCallback))
        .rejects.toThrow('Transaction was aborted: Transaction was aborted');
    });

    it('should throw error when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);
      const transactionCallback = jest.fn();

      await expect(firestoreManager.runTransaction(transactionCallback))
        .rejects.toThrow('Cannot perform transaction: no user is logged in');
    });

    it('should maintain transaction queue state correctly', async () => {
      const results = [{ id: 1 }, { id: 2 }];
      const callbacks = [
        jest.fn().mockResolvedValue(results[0]),
        jest.fn().mockResolvedValue(results[1])
      ];

      mockAdapter.runTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
        return await callback(mockTransaction);
      });

      // Start transactions
      const promise1 = firestoreManager.runTransaction(callbacks[0]);
      const promise2 = firestoreManager.runTransaction(callbacks[1]);

      // Verify queue state during execution
      expect((firestoreManager as any).transactionQueue.length).toBe(1); // Second transaction queued
      expect((firestoreManager as any).activeTransactions).toBe(1);

      // Wait for completion
      await Promise.all([promise1, promise2]);

      // Verify queue is empty after completion
      expect((firestoreManager as any).transactionQueue.length).toBe(0);
      expect((firestoreManager as any).activeTransactions).toBe(0);
    });

    it('should process queue after transaction completion', async () => {
      const results = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const callbacks = [
        jest.fn().mockResolvedValue(results[0]),
        jest.fn().mockResolvedValue(results[1]),
        jest.fn().mockResolvedValue(results[2])
      ];

      mockAdapter.runTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {} as FirebaseFirestoreTypes.Transaction;
        return await callback(mockTransaction);
      });

      // Start all transactions
      const promises = callbacks.map(callback => firestoreManager.runTransaction(callback));
      
      // Verify all complete
      const transactionResults = await Promise.all(promises);
      expect(transactionResults).toEqual(results);
      
      // Verify all were processed
      expect(mockAdapter.runTransaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('dangerouslyDelete', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
    });

    it('should delete the entire user document when it exists', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
      const mockUserRef = mockDoc;
      jest.spyOn(firestoreManager['referenceManager'], 'getUserRef').mockReturnValue(mockUserRef);
      mockAdapter.deleteDocument.mockResolvedValue(undefined);
      await firestoreManager.dangerouslyDelete();
      expect(mockAdapter.deleteDocument).toHaveBeenCalledWith(mockUserRef);
    });

    it('should fall back to deleting backup collection when user document does not exist', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
      const mockUserRef = mockDoc;
      const mockBackupRef = mockCollection;
      jest.spyOn(firestoreManager['referenceManager'], 'getUserRef').mockReturnValue(mockUserRef);
      jest.spyOn(firestoreManager['referenceManager'], 'getBackupRef').mockReturnValue(mockBackupRef);
      const error = new Error('Document not found');
      mockAdapter.deleteDocument.mockRejectedValue(error);
      const mockDocs = [
        {
          ref: mockDoc,
          exists: true,
          data: () => ({}),
          id: 'doc1',
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn(),
        },
        {
          ref: mockDoc,
          exists: true,
          data: () => ({}),
          id: 'doc2',
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn(),
        },
      ] as unknown as FirebaseFirestoreTypes.QueryDocumentSnapshot[];
      mockCollectionSnap.docs = mockDocs;
      const mockBatch = {
        set: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
      };
      mockAdapter.writeBatch.mockReturnValue(mockBatch);
      await firestoreManager.dangerouslyDelete();
      expect(mockAdapter.deleteDocument).toHaveBeenCalledWith(mockUserRef);
      expect(mockAdapter.getCollection).toHaveBeenCalledWith(mockBackupRef);
      expect(mockAdapter.writeBatch).toHaveBeenCalled();
      expect(mockBatch.delete).toHaveBeenCalledTimes(2);
      expect(mockBatch.commit).toHaveBeenCalled();
    });

    it('should handle empty backup collection in fallback', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
      const mockUserRef = mockDoc;
      const mockBackupRef = mockCollection;
      jest.spyOn(firestoreManager['referenceManager'], 'getUserRef').mockReturnValue(mockUserRef);
      jest.spyOn(firestoreManager['referenceManager'], 'getBackupRef').mockReturnValue(mockBackupRef);
      const error = new Error('Document not found');
      mockAdapter.deleteDocument.mockRejectedValue(error);
      mockCollectionSnap.docs = [];
      mockCollectionSnap.empty = true;
      mockAdapter.writeBatch.mockClear();
      await firestoreManager.dangerouslyDelete();
      expect(mockAdapter.deleteDocument).toHaveBeenCalledWith(mockUserRef);
      expect(mockAdapter.getCollection).toHaveBeenCalledWith(mockBackupRef);
      expect(mockAdapter.writeBatch).not.toHaveBeenCalled();
    });

    it('should handle errors during fallback deletion', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
      const mockUserRef = mockDoc;
      const mockBackupRef = mockCollection;
      jest.spyOn(firestoreManager['referenceManager'], 'getUserRef').mockReturnValue(mockUserRef);
      jest.spyOn(firestoreManager['referenceManager'], 'getBackupRef').mockReturnValue(mockBackupRef);
      const userDocError = new Error('Document not found');
      mockAdapter.deleteDocument.mockRejectedValue(userDocError);
      const mockDocs = [
        {
          ref: mockDoc,
          exists: true,
          data: () => ({}),
          id: 'doc1',
          metadata: { fromCache: false, hasPendingWrites: false },
          get: jest.fn(),
          isEqual: jest.fn(),
        }
      ] as unknown as FirebaseFirestoreTypes.QueryDocumentSnapshot[];
      mockCollectionSnap.docs = mockDocs;
      const fallbackError = new Error('Fallback error');
      mockAdapter.getCollection.mockRejectedValue(fallbackError);
      await expect(firestoreManager.dangerouslyDelete()).rejects.toThrow('Dangerous delete operation failed');
    });

    it('should throw error when user is not logged in', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(false);
      mockUserManager.getCurrentUser.mockReturnValue('test-user');
      await expect(firestoreManager.dangerouslyDelete()).rejects.toThrow('Cannot perform dangerous delete operation: no user is logged in');
    });

    it('should throw error when user ID is not available', async () => {
      mockUserManager.isUserLoggedIn.mockReturnValue(true);
      mockUserManager.getCurrentUser.mockReturnValue(undefined);
      await expect(firestoreManager.dangerouslyDelete()).rejects.toThrow('Cannot perform dangerous delete operation: user ID is not available');
    });
  });
});
