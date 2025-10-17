export class MockFirestore {
  private _store: Map<string, any> = new Map();

  async setDoc(path: string, data: any): Promise<void> {
    this._store.set(path, data);
  }

  async getDoc(path: string): Promise<{ exists: boolean; data: () => any }> {
    const data = this._store.get(path);
    return {
      exists: !!data,
      data: () => data,
    };
  }

  async deleteDoc(path: string): Promise<void> {
    this._store.delete(path);
  }

  async getDocs(path: string): Promise<{ empty: boolean; docs: Array<{ data: () => any; ref: { id: string } }> }> {
    const docs = Array.from(this._store.entries())
      .filter(([key]) => key.startsWith(path))
      .map(([key, data]) => ({
        data: () => data,
        ref: { id: key.split('/').pop() || '' },
      }));

    return {
      empty: docs.length === 0,
      docs,
    };
  }

  clearAll(): void {
    this._store.clear();
  }

  // Add method to get store data for testing
  getStoreData(): Map<string, any> {
    return new Map(this._store);
  }

  // Add method to get store keys for testing
  getStoreKeys(): string[] {
    return Array.from(this._store.keys());
  }
}

// Create mock functions with proper types
const mockFirestore = {
  firestore: jest.fn().mockReturnValue({
    collection: jest.fn().mockImplementation((_path: string) => ({
      doc: jest.fn().mockImplementation((_docPath: string) => ({
        collection: jest.fn().mockImplementation((_subPath: string) => ({
          doc: jest.fn().mockImplementation((_subDocPath: string) => ({
            set: jest.fn().mockImplementation(async (_data: any) => {}),
            get: jest.fn().mockImplementation(async () => ({ exists: false, data: () => null })),
            delete: jest.fn().mockImplementation(async () => {}),
          })),
          get: jest.fn().mockImplementation(async () => ({ empty: true, docs: [] })),
        })),
        set: jest.fn().mockImplementation(async (_data: any) => {}),
        get: jest.fn().mockImplementation(async () => ({ exists: false, data: () => null })),
        delete: jest.fn().mockImplementation(async () => {}),
      })),
      get: jest.fn().mockImplementation(async () => ({ empty: true, docs: [] })),
    })),
    doc: jest.fn().mockImplementation((_path: string) => ({
      collection: jest.fn().mockImplementation((_subPath: string) => ({
        doc: jest.fn().mockImplementation((_subDocPath: string) => ({
          set: jest.fn().mockImplementation(async (_data: any) => {}),
          get: jest.fn().mockImplementation(async () => ({ exists: false, data: () => null })),
          delete: jest.fn().mockImplementation(async () => {}),
        })),
        get: jest.fn().mockImplementation(async () => ({ empty: true, docs: [] })),
      })),
      set: jest.fn().mockImplementation(async (_data: any) => {}),
      get: jest.fn().mockImplementation(async () => ({ exists: false, data: () => null })),
      delete: jest.fn().mockImplementation(async () => {}),
    })),
    getDoc: jest.fn().mockImplementation(async () => ({ exists: false, data: () => null })),
    setDoc: jest.fn().mockImplementation(async (_path: string, _data: any) => {}),
    getDocs: jest.fn().mockImplementation(async () => ({ empty: true, docs: [] })),
    writeBatch: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      commit: jest.fn().mockImplementation(async () => {}),
    })),
  }),
};

export default mockFirestore;
