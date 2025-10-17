import {
  FirebaseFirestoreTypes,
} from '@react-native-firebase/firestore';

import IFirestoreAdapter from '../models/interfaces/IFirestoreAdapter';

/**
 * A mock implementation of FirestoreAdapter for testing purposes.
 * Stores data in memory and provides methods to inspect the stored data.
 */
export class MockFirestoreAdapter implements IFirestoreAdapter {
  private documents: Map<string, any> = new Map();
  private collections: Map<string, Map<string, any>> = new Map();
  private transactionOperations: Array<() => Promise<void>> = [];
  private batchOperations: Array<() => void> = [];

  /**
   * Gets a document from the mock store
   * @param ref - The document reference to get
   * @returns Promise that resolves with a mock document snapshot
   */
  async getDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    const path = ref.path;
    const data = this.documents.get(path);

    const mockDoc = {
      exists: data !== undefined,
      data: () => data,
      id: ref.id,
      ref,
      metadata: { fromCache: false, hasPendingWrites: false },
      get: (fieldPath: string) => data?.[fieldPath],
      isEqual: (other: FirebaseFirestoreTypes.DocumentSnapshot) => other.id === ref.id,
    };

    return mockDoc as unknown as FirebaseFirestoreTypes.DocumentSnapshot;
  }

  /**
   * Sets a document in the mock store
   * @param ref - The document reference to set
   * @param data - The data to set
   * @param options - Optional set options (e.g. merge)
   */
  async setDocument(
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    const path = ref.path;

    if (options?.merge) {
      const existingData = this.documents.get(path) || {};
      this.documents.set(path, { ...existingData, ...data });
    } else {
      this.documents.set(path, data);
    }
  }

  /**
   * Updates a document in the mock store
   * @param ref - The document reference to update
   * @param data - The data to update
   */
  async updateDocument(ref: FirebaseFirestoreTypes.DocumentReference, data: any): Promise<void> {
    const path = ref.path;
    const existingData = this.documents.get(path) || {};
    this.documents.set(path, { ...existingData, ...data });
  }

  /**
   * Deletes a document from the mock store
   * @param ref - The document reference to delete
   */
  async deleteDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<void> {
    const path = ref.path;
    this.documents.delete(path);
  }

  /**
   * Gets a collection from the mock store
   * @param ref - The collection reference to get
   * @returns Promise that resolves with a mock query snapshot
   */
  async getCollection(ref: FirebaseFirestoreTypes.CollectionReference): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    const path = ref.path;
    const collectionData = this.collections.get(path) || new Map();

    const docs = Array.from(collectionData.entries()).map(([id, docData]) => {
      const docRef = { id, path: `${path}/${id}` } as FirebaseFirestoreTypes.DocumentReference;
      return {
        id,
        exists: true,
        data: () => docData,
        ref: docRef,
        metadata: { fromCache: false, hasPendingWrites: false },
        get: (fieldPath: string) => docData?.[fieldPath],
        isEqual: (other: FirebaseFirestoreTypes.DocumentSnapshot) => other.id === id,
      } as FirebaseFirestoreTypes.DocumentSnapshot;
    });

    const mockQuerySnapshot = {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      metadata: { fromCache: false, hasPendingWrites: false },
      forEach: (callback: (doc: FirebaseFirestoreTypes.DocumentSnapshot) => void) => {
        docs.forEach(callback);
      },
    };

    return mockQuerySnapshot as unknown as FirebaseFirestoreTypes.QuerySnapshot;
  }

  /**
   * Runs a transaction in the mock store
   * @param updateFunction - The function to run in the transaction
   */
  async runTransaction<T>(updateFunction: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<T>): Promise<T> {
    const mockTransaction = {
      get: async (ref: FirebaseFirestoreTypes.DocumentReference) => this.getDocument(ref),
      set: async (ref: FirebaseFirestoreTypes.DocumentReference, data: any, options?: FirebaseFirestoreTypes.SetOptions) => {
        this.transactionOperations.push(async () => {
          await this.setDocument(ref, data, options);
        });
      },
      update: async (ref: FirebaseFirestoreTypes.DocumentReference, data: any) => {
        this.transactionOperations.push(async () => {
          await this.updateDocument(ref, data);
        });
      },
      delete: async (ref: FirebaseFirestoreTypes.DocumentReference) => {
        this.transactionOperations.push(async () => {
          await this.deleteDocument(ref);
        });
      },
    } as unknown as FirebaseFirestoreTypes.Transaction;

    const result = await updateFunction(mockTransaction);

    for (const operation of this.transactionOperations) {
      await operation();
    }

    this.transactionOperations = [];
    return result;
  }

  /**
   * Creates a new mock write batch
   * @returns A mock write batch instance
   */
  writeBatch(): FirebaseFirestoreTypes.WriteBatch {
    const batch: FirebaseFirestoreTypes.WriteBatch = {
      set: (ref: FirebaseFirestoreTypes.DocumentReference, data: any, options?: FirebaseFirestoreTypes.SetOptions) => {
        this.batchOperations.push(() => {
          this.setDocument(ref, data, options);
        });
        return batch;
      },
      update: (ref: FirebaseFirestoreTypes.DocumentReference, data: any) => {
        this.batchOperations.push(() => {
          this.updateDocument(ref, data);
        });
        return batch;
      },
      delete: (ref: FirebaseFirestoreTypes.DocumentReference) => {
        this.batchOperations.push(() => {
          this.deleteDocument(ref);
        });
        return batch;
      },
      commit: async () => {
        for (const operation of this.batchOperations) {
          operation();
        }
        this.batchOperations = [];
      },
    } as FirebaseFirestoreTypes.WriteBatch;

    return batch;
  }

  // Test helper methods

  /**
   * Gets all stored documents
   * @returns A map of document paths to their data
   */
  getAllDocuments(): Map<string, any> {
    return new Map(this.documents);
  }

  /**
   * Gets all stored collections
   * @returns A map of collection paths to their documents
   */
  getAllCollections(): Map<string, Map<string, any>> {
    return new Map(this.collections);
  }

  /**
   * Clears all stored data
   */
  clear(): void {
    this.documents.clear();
    this.collections.clear();
    this.transactionOperations = [];
    this.batchOperations = [];
  }

  /**
   * Gets a specific document's data
   * @param path - The document path
   * @returns The document data or undefined if not found
   */
  getDocumentData(path: string): any {
    return this.documents.get(path);
  }

  /**
   * Gets a specific collection's data
   * @param path - The collection path
   * @returns A map of document IDs to their data, or undefined if not found
   */
  getCollectionData(path: string): Map<string, any> | undefined {
    return this.collections.get(path);
  }

  async getDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference
  ): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    return transaction.get(ref);
  }

  async setDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    transaction.set(ref, data, options);
  }

  async updateDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any
  ): Promise<void> {
    transaction.update(ref, data);
  }

  async deleteDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference
  ): Promise<void> {
    transaction.delete(ref);
  }
}

export default MockFirestoreAdapter; 