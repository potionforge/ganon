import { deepMerge } from '../../src/__tests__/utils/deepMerge';
import { getFakeFromModule, getRefOwner } from '../../src/__tests__/utils/FakeFirestore';

// Define the types
export type DocumentReference = {
  path: string;
  id: string;
};

export type CollectionReference = {
  path: string;
  id: string;
};

// Create the mock implementations
class MockDocumentReference implements DocumentReference {
  constructor(public path: string) {}
  get id() {
    return this.path.split('/').pop() || '';
  }
}

class MockCollectionReference implements CollectionReference {
  parent?: MockDocumentReference;

  constructor(public path: string, parent?: MockDocumentReference) {
    this.parent = parent;
  }
  get id() {
    return this.path.split('/').pop() || '';
  }
  doc(id: string) {
    return new MockDocumentReference(`${this.path}/${id}`);
  }
}

// Create the mock store with proper path handling
class MockStore {
  private store = new Map<string, any>();

  set(path: string, data: any) {
    this.store.set(path, data);
  }

  get(path: string) {
    return this.store.get(path);
  }

  delete(path: string) {
    this.store.delete(path);
  }

  getDocsInCollection(collectionPath: string) {
    return Array.from(this.store.entries())
      .filter(([path]) => path.startsWith(collectionPath + '/'))
      .map(([path, data]) => ({
        id: path.split('/').pop() || '',
        ref: new MockDocumentReference(path),
        data: () => data,
      }));
  }

  clear() {
    this.store.clear();
  }
}

const mockStore = new MockStore();

function isReference(obj: any): obj is { path: string } {
  return typeof obj === 'object' && obj !== null && typeof obj.path === 'string';
}

const mockFirestore = {
  collection: (pathOrFirestore: any, ...pathSegments: string[]) => {
    const fake = getFakeFromModule(pathOrFirestore);
    if (fake) {
      return fake.collection(pathOrFirestore, ...pathSegments);
    }
    const owner = getRefOwner(pathOrFirestore);
    if (owner) {
      return owner.collection(pathOrFirestore, ...pathSegments);
    }
    const segments =
      typeof pathOrFirestore === 'string' || isReference(pathOrFirestore)
        ? [isReference(pathOrFirestore) ? pathOrFirestore.path : pathOrFirestore, ...pathSegments]
        : pathSegments;
    const fullPath = segments.filter(Boolean).join('/');
    const parentDoc =
      isReference(pathOrFirestore) && pathSegments.length > 0
        ? pathOrFirestore instanceof MockDocumentReference
          ? pathOrFirestore
          : new MockDocumentReference(pathOrFirestore.path)
        : undefined;
    return new MockCollectionReference(fullPath, parentDoc);
  },
  doc: (pathOrFirestore: any, ...pathSegments: string[]) => {
    const fake = getFakeFromModule(pathOrFirestore);
    if (fake) {
      return fake.doc(pathOrFirestore, ...pathSegments);
    }
    const owner = getRefOwner(pathOrFirestore);
    if (owner) {
      return owner.doc(pathOrFirestore, ...pathSegments);
    }
    const segments =
      typeof pathOrFirestore === 'string' || isReference(pathOrFirestore)
        ? [isReference(pathOrFirestore) ? pathOrFirestore.path : pathOrFirestore, ...pathSegments]
        : pathSegments;
    const fullPath = segments.filter(Boolean).join('/');
    return new MockDocumentReference(fullPath);
  },
  getDoc: async (ref: DocumentReference) => {
    const owner = getRefOwner(ref);
    if (owner) {
      return owner.getDoc(ref);
    }
    const data = mockStore.get(ref.path);
    return {
      exists: !!data,
      data: () => data || {},
      ref,
    };
  },
  getDocs: async (ref: CollectionReference) => {
    const owner = getRefOwner(ref);
    if (owner) {
      return owner.getDocs(ref);
    }
    const docs = mockStore.getDocsInCollection(ref.path);
    return {
      empty: docs.length === 0,
      docs,
    };
  },
  setDoc: async (ref: DocumentReference, data: any, options?: { merge?: boolean }) => {
    const owner = getRefOwner(ref);
    if (owner) {
      return owner.setDoc(ref, data, options);
    }
    if (options?.merge) {
      const existing = mockStore.get(ref.path) || {};
      mockStore.set(ref.path, deepMerge(existing, data));
    } else {
      mockStore.set(ref.path, data);
    }
  },
  updateDoc: async (ref: DocumentReference, data: any) => {
    const owner = getRefOwner(ref);
    if (owner) {
      return owner.updateDoc(ref, data);
    }
    const existing = mockStore.get(ref.path) || {};
    mockStore.set(ref.path, deepMerge(existing, data));
  },
  deleteDoc: async (ref: DocumentReference) => {
    const owner = getRefOwner(ref);
    if (owner) {
      return owner.deleteDoc(ref);
    }
    mockStore.delete(ref.path);
  },
  writeBatch: (firestore?: unknown) => {
    const fake = getFakeFromModule(firestore);
    if (fake) {
      return fake.writeBatch();
    }
    const pending: Array<() => void | Promise<void>> = [];
    const batch = {
      set: (ref: DocumentReference, data: any, options?: { merge?: boolean }) => {
        pending.push(() => mockFirestore.setDoc(ref, data, options));
        return batch;
      },
      update: (ref: DocumentReference, data: any) => {
        pending.push(() => mockFirestore.updateDoc(ref, data));
        return batch;
      },
      delete: (ref: DocumentReference) => {
        pending.push(() => mockStore.delete(ref.path));
        return batch;
      },
      commit: async () => {
        for (const op of pending) {
          await op();
        }
      },
    };
    return batch;
  },
  query: () => ({}),
  // Unsupported: Ganon does not use deleteField() with merge writes. Real sentinel would delete the key.
  deleteField: () => ({}),
  runTransaction: async <T>(
    firestore: unknown,
    updateFunction: (transaction: {
      get: (ref: DocumentReference) => Promise<{ exists: boolean; data: () => any }>;
      set: (ref: DocumentReference, data: any, options?: { merge?: boolean }) => Promise<void>;
      update: (ref: DocumentReference, data: any) => Promise<void>;
      delete: (ref: DocumentReference) => Promise<void>;
    }) => Promise<T>
  ): Promise<T> => {
    const fake = getFakeFromModule(firestore);
    if (fake) {
      return fake.runTransaction(updateFunction);
    }
    const pending: Array<() => void | Promise<void>> = [];
    let hasWrites = false;
    const transaction = {
      get: async (ref: DocumentReference) => {
        if (hasWrites) {
          throw new Error('Firestore transactions disallow reading after writing');
        }
        return mockFirestore.getDoc(ref);
      },
      set: async (ref: DocumentReference, data: any, options?: { merge?: boolean }) => {
        hasWrites = true;
        pending.push(() => mockFirestore.setDoc(ref, data, options));
      },
      update: async (ref: DocumentReference, data: any) => {
        hasWrites = true;
        pending.push(() => mockFirestore.setDoc(ref, data, { merge: true }));
      },
      delete: async (ref: DocumentReference) => {
        hasWrites = true;
        pending.push(() => mockStore.delete(ref.path));
      },
    };
    const result = await updateFunction(transaction);
    for (const op of pending) {
      await op();
    }
    return result;
  },
};

// Export everything
export const collection = mockFirestore.collection;
export const doc = mockFirestore.doc;
export const getDoc = mockFirestore.getDoc;
export const getDocs = mockFirestore.getDocs;
export const setDoc = mockFirestore.setDoc;
export const updateDoc = mockFirestore.updateDoc;
export const deleteDoc = mockFirestore.deleteDoc;
export const writeBatch = mockFirestore.writeBatch;
export const query = mockFirestore.query;
export const deleteField = mockFirestore.deleteField;
export const runTransaction = mockFirestore.runTransaction;
export const getFirestore = () => mockFirestore;

// Export types for use in tests
export type FirebaseFirestoreTypes = {
  DocumentReference: typeof MockDocumentReference;
  CollectionReference: typeof MockCollectionReference;
};

// Export mock store for test utilities
export const getMockStore = () => mockStore;
export const clearMockStore = () => mockStore.clear();

export default mockFirestore;
