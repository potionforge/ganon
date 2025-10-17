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
  constructor(public path: string) {}
  get id() {
    return this.path.split('/').pop() || '';
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
  collection: (path: string | { path: string }, ...pathSegments: string[]) => {
    const basePath = isReference(path) ? path.path : path;
    const fullPath = [basePath, ...pathSegments].join('/');
    return new MockCollectionReference(fullPath);
  },
  doc: (path: string | { path: string }, ...pathSegments: string[]) => {
    const basePath = isReference(path) ? path.path : path;
    const fullPath = [basePath, ...pathSegments].join('/');
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
  setDoc: async (ref: DocumentReference, data: any) => {
    mockStore.set(ref.path, data);
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