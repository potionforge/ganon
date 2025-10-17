import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';

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
  }))
}));

// Mock Log to capture log messages
jest.mock('../../utils/Log', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
  info: jest.fn()
}));

// Create a test storage mapping
interface TestStorageMapping extends BaseStorageMapping {
  testKey: string;
  anotherKey: number;
}

describe('FirestoreAdapter', () => {
  let adapter: FirestoreAdapter<TestStorageMapping>;
  let readOnlyAdapter: FirestoreAdapter<TestStorageMapping>;
  let mockRef: FirebaseFirestoreTypes.DocumentReference;
  let mockTransaction: FirebaseFirestoreTypes.Transaction;
  let mockCollectionRef: FirebaseFirestoreTypes.CollectionReference;

  // Create test configs
  const createTestConfig = (remoteReadonly = false): GanonConfig<TestStorageMapping> => ({
    identifierKey: 'testKey',
    cloudConfig: {
      firestore: {
        collection: 'test-collection'
      }
    } as any,
    remoteReadonly
  });

  beforeEach(() => {
    // Create regular adapter (writable)
    adapter = new FirestoreAdapter(createTestConfig(false));
    
    // Create read-only adapter
    readOnlyAdapter = new FirestoreAdapter(createTestConfig(true));
    
    mockRef = {
      path: 'test/path',
      id: 'test-id',
      parent: {} as any,
      collection: jest.fn()
    } as any;
    
    mockCollectionRef = {
      path: 'test-collection',
      id: 'test-collection',
      parent: {} as any,
      doc: jest.fn(() => mockRef)
    } as any;
    
    mockTransaction = {
      get: jest.fn(() => Promise.resolve({})),
      set: jest.fn(),
      update: jest.fn(),
      delete: jest.fn()
    } as any;
  });

  describe('Read-Only Mode Behavior', () => {
    describe('validateAndSanitizeData in read-only mode', () => {
      it('should skip validation and return data as-is when remoteReadonly is true', () => {
        const testData = {
          normal: 'value',
          undefined: undefined,
          func: () => {},
          symbol: Symbol('test'),
          nested: {
            invalid: undefined,
            valid: 'value'
          }
        };

        const result = (readOnlyAdapter as any).validateAndSanitizeData(testData, 'test');
        
        // Should return data exactly as provided, no validation
        expect(result).toEqual(testData);
      });

      it('should perform normal validation when remoteReadonly is false', () => {
        const testData = {
          normal: 'value',
          undefined: undefined,
          func: () => {},
          symbol: Symbol('test')
        };

        const result = (adapter as any).validateAndSanitizeData(testData, 'test');
        
        // Should perform normal validation and filtering
        expect(result).toEqual({
          normal: 'value'
        });
      });
    });

    describe('Write Operations in Read-Only Mode', () => {
      it('should block setDocument when remoteReadonly is true', async () => {
        const data = { test: 'value' };
        
        await readOnlyAdapter.setDocument(mockRef, data);
        
        // Should not call the actual setDoc function
        const { setDoc } = require('@react-native-firebase/firestore');
        expect(setDoc).not.toHaveBeenCalled();
      });

      it('should block setDocumentWithTransaction when remoteReadonly is true', async () => {
        const data = { test: 'value' };
        
        await readOnlyAdapter.setDocumentWithTransaction(mockTransaction, mockRef, data);
        
        // Should not call transaction.set
        expect(mockTransaction.set).not.toHaveBeenCalled();
      });

      it('should block updateDocument when remoteReadonly is true', async () => {
        const data = { test: 'value' };
        
        await readOnlyAdapter.updateDocument(mockRef, data);
        
        // Should not call the actual updateDoc function
        const { updateDoc } = require('@react-native-firebase/firestore');
        expect(updateDoc).not.toHaveBeenCalled();
      });

      it('should block updateDocumentWithTransaction when remoteReadonly is true', async () => {
        const data = { test: 'value' };
        
        await readOnlyAdapter.updateDocumentWithTransaction(mockTransaction, mockRef, data);
        
        // Should not call transaction.update
        expect(mockTransaction.update).not.toHaveBeenCalled();
      });

      it('should block deleteDocument when remoteReadonly is true', async () => {
        await readOnlyAdapter.deleteDocument(mockRef);
        
        // Should not call the actual deleteDoc function
        const { deleteDoc } = require('@react-native-firebase/firestore');
        expect(deleteDoc).not.toHaveBeenCalled();
      });

      it('should block deleteDocumentWithTransaction when remoteReadonly is true', async () => {
        await readOnlyAdapter.deleteDocumentWithTransaction(mockTransaction, mockRef);
        
        // Should not call transaction.delete
        expect(mockTransaction.delete).not.toHaveBeenCalled();
      });

      it('should throw error for runTransaction when remoteReadonly is true', async () => {
        const updateFunction = jest.fn();
        
        await expect(readOnlyAdapter.runTransaction(updateFunction)).rejects.toThrow(
          'Cannot run transactions in read-only mode'
        );
        
        // Should not call the actual runTransaction function
        const { runTransaction } = require('@react-native-firebase/firestore');
        expect(runTransaction).not.toHaveBeenCalled();
      });

      it('should throw error for writeBatch when remoteReadonly is true', () => {
        expect(() => readOnlyAdapter.writeBatch()).toThrow(
          'Cannot create write batches in read-only mode'
        );
        
        // Should not call the actual writeBatch function
        const { writeBatch } = require('@react-native-firebase/firestore');
        expect(writeBatch).not.toHaveBeenCalled();
      });
    });

    describe('Read Operations in Read-Only Mode', () => {
      it('should allow getDocument when remoteReadonly is true', async () => {
        await readOnlyAdapter.getDocument(mockRef);
        
        // Should call the actual getDoc function
        const { getDoc } = require('@react-native-firebase/firestore');
        expect(getDoc).toHaveBeenCalledWith(mockRef);
      });

      it('should allow getCollection when remoteReadonly is true', async () => {
        await readOnlyAdapter.getCollection(mockCollectionRef);
        
        // Should call the actual getDocs function
        const { getDocs } = require('@react-native-firebase/firestore');
        expect(getDocs).toHaveBeenCalledWith(mockCollectionRef);
      });

      it('should allow getDocumentWithTransaction when remoteReadonly is true', async () => {
        await readOnlyAdapter.getDocumentWithTransaction(mockTransaction, mockRef);
        
        // Should call transaction.get
        expect(mockTransaction.get).toHaveBeenCalledWith(mockRef);
      });
    });

    describe('Write Operations in Normal Mode', () => {
      it('should allow setDocument when remoteReadonly is false', async () => {
        const data = { test: 'value' };
        
        await adapter.setDocument(mockRef, data);
        
        // Should call the actual setDoc function
        const { setDoc } = require('@react-native-firebase/firestore');
        expect(setDoc).toHaveBeenCalled();
      });

      it('should allow updateDocument when remoteReadonly is false', async () => {
        const data = { test: 'value' };
        
        await adapter.updateDocument(mockRef, data);
        
        // Should call the actual updateDoc function
        const { updateDoc } = require('@react-native-firebase/firestore');
        expect(updateDoc).toHaveBeenCalled();
      });

      it('should allow deleteDocument when remoteReadonly is false', async () => {
        await adapter.deleteDocument(mockRef);
        
        // Should call the actual deleteDoc function
        const { deleteDoc } = require('@react-native-firebase/firestore');
        expect(deleteDoc).toHaveBeenCalledWith(mockRef);
      });

      it('should allow runTransaction when remoteReadonly is false', async () => {
        const updateFunction = jest.fn();
        
        await adapter.runTransaction(updateFunction);
        
        // Should call the actual runTransaction function
        const { runTransaction } = require('@react-native-firebase/firestore');
        expect(runTransaction).toHaveBeenCalled();
      });

      it('should allow writeBatch when remoteReadonly is false', () => {
        adapter.writeBatch();
        
        // Should call the actual writeBatch function
        const { writeBatch } = require('@react-native-firebase/firestore');
        expect(writeBatch).toHaveBeenCalled();
      });
    });
  });

  describe('setDocument', () => {
    it('should handle null data gracefully', async () => {
      await adapter.setDocument(mockRef, null);
      // Should not crash and should log a warning
    });

    it('should handle undefined data gracefully', async () => {
      await adapter.setDocument(mockRef, undefined);
      // Should not crash and should log a warning
    });

    it('should handle data with null keys gracefully', async () => {
      const data = { [null as any]: 'value', normal: 'value' };
      await adapter.setDocument(mockRef, data);
      // Should skip null keys and only set valid ones
    });

    it('should handle data with undefined values gracefully', async () => {
      const data = { key1: 'value', key2: undefined, key3: 'value' };
      await adapter.setDocument(mockRef, data);
      // Should skip undefined values
    });

    it('should handle functions and symbols gracefully', async () => {
      const data = {
        func: () => {},
        symbol: Symbol('test'),
        normal: 'value'
      };
      await adapter.setDocument(mockRef, data);
      // Should skip functions and symbols
    });
  });

  describe('setDocumentWithTransaction', () => {
    it('should handle null data gracefully', async () => {
      await adapter.setDocumentWithTransaction(mockTransaction, mockRef, null);
      // Should not crash and should log a warning
    });

    it('should handle undefined data gracefully', async () => {
      await adapter.setDocumentWithTransaction(mockTransaction, mockRef, undefined);
      // Should not crash and should log a warning
    });

    it('should handle data with null keys gracefully', async () => {
      const data = { [null as any]: 'value', normal: 'value' };
      await adapter.setDocumentWithTransaction(mockTransaction, mockRef, data);
      // Should skip null keys and only set valid ones
    });

    it('should handle data with undefined values gracefully', async () => {
      const data = { key1: 'value', key2: undefined, key3: 'value' };
      await adapter.setDocumentWithTransaction(mockTransaction, mockRef, data);
      // Should skip undefined values
    });
  });

  describe('updateDocument', () => {
    it('should handle null data gracefully', async () => {
      await adapter.updateDocument(mockRef, null);
      // Should not crash and should log a warning
    });

    it('should handle undefined data gracefully', async () => {
      await adapter.updateDocument(mockRef, undefined);
      // Should not crash and should log a warning
    });
  });

  describe('updateDocumentWithTransaction', () => {
    it('should handle null data gracefully', async () => {
      await adapter.updateDocumentWithTransaction(mockTransaction, mockRef, null);
      // Should not crash and should log a warning
    });

    it('should handle undefined data gracefully', async () => {
      await adapter.updateDocumentWithTransaction(mockTransaction, mockRef, undefined);
      // Should not crash and should log a warning
    });
  });

  describe('validateAndSanitizeData', () => {
    it('should convert null data to empty object', () => {
      const result = (adapter as any).validateAndSanitizeData(null, 'test');
      expect(result).toEqual({ _empty: true });
    });

    it('should convert undefined data to empty object', () => {
      const result = (adapter as any).validateAndSanitizeData(undefined, 'test');
      expect(result).toEqual({ _empty: true });
    });

    it('should convert non-object data to object', () => {
      const result = (adapter as any).validateAndSanitizeData('string', 'test');
      expect(result).toEqual({ value: 'string' });
    });

    it('should filter out invalid keys and values', () => {
      const data = {
        [null as any]: 'value1',
        undefined: 'value2',
        '': 'value3',
        normal: 'value4',
        func: () => {},
        symbol: Symbol('test'),
        undef: undefined
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      // null and undefined keys get converted to strings, empty string gets filtered
      expect(result).toEqual({ 
        'null': 'value1',
        'undefined': 'value2',
        normal: 'value4'
      });
    });

    it('should return empty object with _empty flag when no valid fields', () => {
      const data = {
        '': 'value3',
        func: () => {},
        symbol: Symbol('test'),
        undef: undefined
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({ _empty: true });
    });

    // 🆕 NEW TESTS FOR NESTED NIL VALUE HANDLING
    it('should handle nested objects with undefined values', () => {
      const data = {
        user: {
          name: 'John',
          email: undefined, // This should be removed
          profile: {
            avatar: undefined, // This should be removed
            bio: 'Developer'
          }
        },
        settings: {
          theme: 'dark',
          notifications: undefined // This should be removed
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        user: {
          name: 'John',
          profile: {
            bio: 'Developer'
          }
        },
        settings: {
          theme: 'dark'
        }
      });
    });

    it('should handle nested objects with null values (null is allowed)', () => {
      const data = {
        user: {
          name: 'John',
          email: null, // null is allowed
          profile: {
            avatar: null, // null is allowed
            bio: 'Developer'
          }
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        user: {
          name: 'John',
          email: null,
          profile: {
            avatar: null,
            bio: 'Developer'
          }
        }
      });
    });

    it('should handle deeply nested undefined values', () => {
      const data = {
        level1: {
          level2: {
            level3: {
              level4: {
                valid: 'value',
                undefined: undefined // Should be removed
              }
            }
          }
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        level1: {
          level2: {
            level3: {
              level4: {
                valid: 'value'
              }
            }
          }
        }
      });
    });

    it('should handle arrays with nested undefined values', () => {
      const data = {
        users: [
          { name: 'John', email: 'john@example.com' },
          { name: 'Jane', email: undefined }, // Should be removed from object
          { name: 'Bob', email: 'bob@example.com' }
        ],
        settings: [
          { key: 'theme', value: 'dark' },
          { key: 'notifications', value: undefined }, // Should be removed from object
          { key: 'language', value: 'en' }
        ]
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        users: [
          { name: 'John', email: 'john@example.com' },
          { name: 'Jane' }, // email removed from object
          { name: 'Bob', email: 'bob@example.com' }
        ],
        settings: [
          { key: 'theme', value: 'dark' },
          { key: 'notifications' }, // value removed from object, but object kept
          { key: 'language', value: 'en' }
        ]
      });
    });

    it('should handle arrays with nested objects containing undefined', () => {
      const data = {
        posts: [
          { title: 'Post 1', content: 'Content 1', metadata: { author: 'John', date: undefined } },
          { title: 'Post 2', content: 'Content 2', metadata: { author: 'Jane', date: '2023-01-01' } }
        ]
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        posts: [
          { title: 'Post 1', content: 'Content 1', metadata: { author: 'John' } },
          { title: 'Post 2', content: 'Content 2', metadata: { author: 'Jane', date: '2023-01-01' } }
        ]
      });
    });

    it('should remove empty nested objects after undefined removal', () => {
      const data = {
        user: {
          profile: {
            avatar: undefined,
            bio: undefined
          },
          settings: {
            theme: 'dark'
          }
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        user: {
          settings: {
            theme: 'dark'
          }
        }
      });
    });

    it('should handle mixed null and undefined values correctly', () => {
      const data = {
        user: {
          name: 'John',
          email: null, // null is allowed
          phone: undefined, // undefined should be removed
          profile: {
            avatar: null, // null is allowed
            bio: undefined, // undefined should be removed
            preferences: {
              theme: 'dark',
              notifications: null // null is allowed
            }
          }
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        user: {
          name: 'John',
          email: null,
          profile: {
            avatar: null,
            preferences: {
              theme: 'dark',
              notifications: null
            }
          }
        }
      });
    });

    it('should handle functions and symbols in nested objects', () => {
      const data = {
        user: {
          name: 'John',
          handler: () => {}, // Should be removed
          symbol: Symbol('test'), // Should be removed
          profile: {
            avatar: 'avatar.jpg',
            callback: () => {}, // Should be removed
            metadata: Symbol('meta') // Should be removed
          }
        }
      };
      const result = (adapter as any).validateAndSanitizeData(data, 'test');
      expect(result).toEqual({
        user: {
          name: 'John',
          profile: {
            avatar: 'avatar.jpg'
          }
        }
      });
    });
  });
}); 