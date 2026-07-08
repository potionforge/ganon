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

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const mockStore = new MockStore();

function isReference(obj: any): obj is { path: string } {
  return typeof obj === 'object' && obj !== null && typeof obj.path === 'string';
}

const mockFirestore = {
  collection: (pathOrFirestore: any, ...pathSegments: string[]) => {
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
    const segments =
      typeof pathOrFirestore === 'string' || isReference(pathOrFirestore)
        ? [isReference(pathOrFirestore) ? pathOrFirestore.path : pathOrFirestore, ...pathSegments]
        : pathSegments;
    const fullPath = segments.filter(Boolean).join('/');
    return new MockDocumentReference(fullPath);
  },
  getDoc: async (ref: DocumentReference) => {
    const data = mockStore.get(ref.path);
    return {
      exists: !!data,
      data: () => data || {},
      ref,
    };
  },
  getDocs: async (ref: CollectionReference) => {
    const docs = mockStore.getDocsInCollection(ref.path);
    return {
      empty: docs.length === 0,
      docs,
    };
  },
  setDoc: async (ref: DocumentReference, data: any, options?: { merge?: boolean }) => {
    if (options?.merge) {
      const existing = mockStore.get(ref.path) || {};
      mockStore.set(ref.path, deepMerge(existing, data));
    } else {
      mockStore.set(ref.path, data);
    }
  },
  deleteDoc: async (ref: DocumentReference) => {
    mockStore.delete(ref.path);
  },
  writeBatch: () => {
    const batch = {
      delete: (ref: DocumentReference) => {
        mockStore.delete(ref.path);
      },
      commit: async () => {},
    };
    return batch;
  },
  query: () => ({}),
  deleteField: () => ({}),
  runTransaction: async <T>(
    _firestore: unknown,
    updateFunction: (transaction: {
      get: (ref: DocumentReference) => Promise<{ exists: boolean; data: () => any }>;
      set: (ref: DocumentReference, data: any, options?: { merge?: boolean }) => Promise<void>;
      update: (ref: DocumentReference, data: any) => Promise<void>;
      delete: (ref: DocumentReference) => Promise<void>;
    }) => Promise<T>
  ): Promise<T> => {
    const pendingSets: Array<{ ref: DocumentReference; data: any; options?: { merge?: boolean } }> = [];
    const transaction = {
      get: async (ref: DocumentReference) => mockFirestore.getDoc(ref),
      set: async (ref: DocumentReference, data: any, options?: { merge?: boolean }) => {
        pendingSets.push({ ref, data, options });
      },
      update: async (ref: DocumentReference, data: any) => {
        pendingSets.push({ ref, data, options: { merge: true } });
      },
      delete: async (ref: DocumentReference) => {
        mockStore.delete(ref.path);
      },
    };
    const result = await updateFunction(transaction);
    for (const { ref, data, options } of pendingSets) {
      await mockFirestore.setDoc(ref, data, options);
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