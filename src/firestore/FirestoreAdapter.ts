import {
  FirebaseFirestoreTypes,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  writeBatch,
  runTransaction,
  getFirestore,
} from '@react-native-firebase/firestore';
import Log from '../utils/Log';
import IFirestoreAdapter from '../models/interfaces/IFirestoreAdapter';
import { GanonConfig } from '../models/config/GanonConfig';
import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';

class FirestoreAdapter<T extends BaseStorageMapping> implements IFirestoreAdapter {
  private firestore: FirebaseFirestoreTypes.Module;
  private _remoteReadonly: boolean;

  constructor(readonly config: GanonConfig<T>, firestore?: FirebaseFirestoreTypes.Module) {
    this.firestore = firestore ?? getFirestore();
    this._remoteReadonly = config.remoteReadonly ?? false;
  }

  /**
   * Validates and sanitizes data before passing to the native Firebase layer
   * This prevents crashes caused by null/undefined keys or values, including nested ones
   */
  private validateAndSanitizeData(data: any, operationName: string): { [key: string]: any } {
    // Skip validation in read-only mode since we're not doing any writes
    if (this._remoteReadonly) {
      Log.verbose(`🔥 ${operationName}: Skipping validation in read-only mode`);
      return data;
    }

    // Handle null/undefined data
    if (data === null || data === undefined) {
      Log.warn(`🔥 ${operationName}: Data is ${data === null ? 'null' : 'undefined'}, using empty object`);
      return { _empty: true };
    }

    // Ensure data is a plain object for the native layer
    if (typeof data !== 'object' || Array.isArray(data)) {
      Log.warn(`🔥 ${operationName}: Data is not a plain object, converting to object`);
      return { value: data };
    }

    // Validate that all keys and values are safe for the native layer
    const validatedData: { [key: string]: any } = {};
    for (const [key, value] of Object.entries(data)) {
      // Skip null/undefined keys
      if (key === null || key === undefined) {
        Log.warn(`🔥 ${operationName}: Skipping null/undefined key`);
        continue;
      }

      // Convert key to string and validate
      const stringKey = String(key);
      if (stringKey.length === 0) {
        Log.warn(`🔥 ${operationName}: Skipping empty key`);
        continue;
      }

      // Skip undefined values (null is allowed)
      if (value === undefined) {
        Log.warn(`🔥 ${operationName}: Skipping undefined value for key "${stringKey}"`);
        continue;
      }

      // Skip functions and symbols
      if (typeof value === 'function' || typeof value === 'symbol') {
        Log.warn(`🔥 ${operationName}: Skipping ${typeof value} value for key "${stringKey}"`);
        continue;
      }

      // 🆕 RECURSIVE VALIDATION FOR NESTED OBJECTS
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const nestedValidated = this.validateAndSanitizeData(value, `${operationName}.${stringKey}`);
        // Only include nested object if it has valid content and is not just {_empty: true}
        const keys = Object.keys(nestedValidated);
        if (keys.length > 0 && !(keys.length === 1 && nestedValidated._empty)) {
          validatedData[stringKey] = nestedValidated;
        } else {
          Log.warn(`🔥 ${operationName}: Skipping empty nested object for key "${stringKey}"`);
        }
        continue;
      }

      // 🆕 HANDLE ARRAYS WITH NESTED VALIDATION
      if (Array.isArray(value)) {
        const validatedArray = value
          .filter(item => item !== undefined) // Remove undefined items
          .map((item, index) => {
            if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
              const validated = this.validateAndSanitizeData(item, `${operationName}.${stringKey}[${index}]`);
              const keys = Object.keys(validated);
              if (keys.length === 0 || (keys.length === 1 && validated._empty)) {
                return undefined;
              }
              return validated;
            }
            return item;
          })
          .filter(item => {
            if (item === undefined) return false;
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const keys = Object.keys(item);
              // Remove if empty or only _empty: true
              return !(keys.length === 0 || (keys.length === 1 && item._empty));
            }
            return true;
          });

        validatedData[stringKey] = validatedArray;
        continue;
      }

      validatedData[stringKey] = value;
    }

    // Ensure we have at least one valid field
    if (Object.keys(validatedData).length === 0) {
      Log.warn(`🔥 ${operationName}: No valid data fields, using empty object`);
      validatedData._empty = true;
    }

    Log.verbose(`🔥 ${operationName}: Validated data has ${Object.keys(validatedData).length} fields`);
    return validatedData;
  }

  /**
   * Gets a document from Firestore
   * @param ref - The document reference to get
   * @returns Promise that resolves with the document snapshot
   */
  async getDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    Log.verbose(`🔥 FirestoreAdapter.getDocument called with ref: ${ref.path}`);
    return getDoc(ref);
  }

  /**
   * Sets a document in Firestore
   * @param ref - The document reference to set
   * @param data - The data to set
   * @param options - Optional set options (e.g. merge)
   * @returns Promise that resolves when the document is set
   */
  async setDocument(
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.setDocument called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.setDocument called with ref: ${ref.path}`);

    try {
      const validatedData = this.validateAndSanitizeData(data, 'setDocument');

      if (options) {
        const result = await setDoc(ref, validatedData, options);
        Log.verbose(`🔥 setDoc completed with options, result: ${result}`);
        return result;
      } else {
        const result = await setDoc(ref, validatedData);
        Log.verbose(`🔥 setDoc completed without options, result: ${result}`);
        return result;
      }
    } catch (error) {
      Log.error(`🔥 setDoc failed: ${error}`);
      throw error;
    }
  }

  /**
   * Sets a document in Firestore within a transaction
   * @param transaction - The transaction to use
   * @param ref - The document reference to set
   * @param data - The data to set
   * @param options - Optional set options (e.g. merge)
   * @returns Promise that resolves when the document is set
   */
  async setDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any,
    options?: FirebaseFirestoreTypes.SetOptions
  ): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.setDocumentWithTransaction called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.setDocumentWithTransaction called with ref: ${ref.path}`);

    try {
      const validatedData = this.validateAndSanitizeData(data, 'setDocumentWithTransaction');

      if (options) {
        transaction.set(ref, validatedData, options);
      } else {
        transaction.set(ref, validatedData);
      }
    } catch (error) {
      Log.error(`🔥 setDocumentWithTransaction failed: ${error}`);
      throw error;
    }
  }

  /**
   * Updates a document in Firestore
   * @param ref - The document reference to update
   * @param data - The data to update
   * @returns Promise that resolves when the document is updated
   */
  async updateDocument(ref: FirebaseFirestoreTypes.DocumentReference, data: any): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.updateDocument called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.updateDocument called with ref: ${ref.path}`);

    try {
      const validatedData = this.validateAndSanitizeData(data, 'updateDocument');

      return updateDoc(ref, validatedData);
    } catch (error) {
      Log.error(`🔥 updateDocument failed: ${error}`);
      throw error;
    }
  }

  /**
   * Updates a document in Firestore within a transaction
   * @param transaction - The transaction to use
   * @param ref - The document reference to update
   * @param data - The data to update
   * @returns Promise that resolves when the document is updated
   */
  async updateDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference,
    data: any
  ): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.updateDocumentWithTransaction called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.updateDocumentWithTransaction called with ref: ${ref.path}`);

    try {
      const validatedData = this.validateAndSanitizeData(data, 'updateDocumentWithTransaction');

      transaction.update(ref, validatedData);
    } catch (error) {
      Log.error(`🔥 updateDocumentWithTransaction failed: ${error}`);
      throw error;
    }
  }

  /**
   * Deletes a document from Firestore
   * @param ref - The document reference to delete
   * @returns Promise that resolves when the document is deleted
   */
  async deleteDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.deleteDocument called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.deleteDocument called with ref: ${ref.path}`);
    return deleteDoc(ref);
  }

  /**
   * Deletes a document from Firestore within a transaction
   * @param transaction - The transaction to use
   * @param ref - The document reference to delete
   * @returns Promise that resolves when the document is deleted
   */
  async deleteDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference
  ): Promise<void> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.deleteDocumentWithTransaction called with ref: ${ref.path}, but remoteReadonly is true`);
      return;
    }

    Log.verbose(`🔥 FirestoreAdapter.deleteDocumentWithTransaction called with ref: ${ref.path}`);
    transaction.delete(ref);
  }

  /**
   * Gets a collection from Firestore
   * @param ref - The collection reference to get
   * @returns Promise that resolves with the query snapshot
   */
  async getCollection(ref: FirebaseFirestoreTypes.CollectionReference): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    Log.verbose(`🔥 FirestoreAdapter.getCollection called with ref: ${ref.path}`);
    return getDocs(ref);
  }

  /**
   * Gets a document from Firestore within a transaction
   * @param transaction - The transaction to use
   * @param ref - The document reference to get
   * @returns Promise that resolves with the document snapshot
   */
  async getDocumentWithTransaction(
    transaction: FirebaseFirestoreTypes.Transaction,
    ref: FirebaseFirestoreTypes.DocumentReference
  ): Promise<FirebaseFirestoreTypes.DocumentSnapshot> {
    Log.verbose(`🔥 FirestoreAdapter.getDocumentWithTransaction called with ref: ${ref.path}`);
    return transaction.get(ref);
  }

  /**
   * Runs a transaction in Firestore
   * @param updateFunction - The function to run in the transaction
   * @returns Promise that resolves with the result of the transaction
   */
  async runTransaction<T>(updateFunction: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<T>): Promise<T> {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.runTransaction called, but remoteReadonly is true`);
      throw new Error('Cannot run transactions in read-only mode');
    }

    Log.verbose(`🔥 FirestoreAdapter.runTransaction called`);
    return runTransaction(this.firestore, updateFunction);
  }

  /**
   * Creates a new write batch
   * @returns A new write batch instance
   */
  writeBatch(): FirebaseFirestoreTypes.WriteBatch {
    if (this._remoteReadonly) {
      Log.warn(`🔥 FirestoreAdapter.writeBatch called, but remoteReadonly is true`);
      throw new Error('Cannot create write batches in read-only mode');
    }

    Log.verbose(`🔥 FirestoreAdapter.writeBatch called`);
    return writeBatch(this.firestore);
  }
}

export default FirestoreAdapter;
