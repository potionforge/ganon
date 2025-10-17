import { CloudBackupConfig } from "../models/config/CloudBackupConfig";
import { ICloudManager } from "../models/interfaces/ICloudManager";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import {
  FirebaseFirestoreTypes,
} from '@react-native-firebase/firestore';
import Log from "../utils/Log";
import SyncError, { SyncErrorType } from "../errors/SyncError";
import FirestoreReferenceManager from "./ref/FirestoreReferenceManager";
import DocumentOrCollection from "../models/firestore/DocumentOrCollection";
import DataProcessor from "./processing/DataProcessor";
import FirestoreAdapter from "./FirestoreAdapter";
import ChunkManager from "./chunking/ChunkManager";
import UserManager from "../managers/UserManager";

export default class FirestoreManager<T extends BaseStorageMapping> implements ICloudManager<T> {
  private referenceManager: FirestoreReferenceManager<T>;
  private dataProcessor: DataProcessor;
  private chunkManager: ChunkManager<T>;
  private userManager: UserManager<T>;

  // Transaction concurrency control
  private transactionQueue: Array<{
    callback: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private activeTransactions = 0;
  private readonly MAX_CONCURRENT_TRANSACTIONS = 1; // Prevent concurrent transaction deadlocks
  private readonly TRANSACTION_TIMEOUT = 10000; // 10 seconds

  constructor(
    public identifierKey: string,
    public cloudConfig: CloudBackupConfig<T>,
    private adapter: FirestoreAdapter<T>,
    userManager: UserManager<T>
  ) {
    this.userManager = userManager;
    this.referenceManager = new FirestoreReferenceManager(userManager, cloudConfig);
    this.dataProcessor = new DataProcessor();
    this.chunkManager = new ChunkManager(this.adapter, this.dataProcessor);
  }

  /**
   * Runs a transaction on Firestore with concurrency control and timeout protection
   * @param callback - The callback to run within the transaction
   * @returns Promise that resolves with the result of the transaction
   * @throws {SyncError} Throws error if transaction fails
   */
  async runTransaction<R>(callback: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<R>): Promise<R> {
    Log.verbose('Ganon: FirestoreManager.runTransaction');

    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot perform transaction: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Queue transaction to prevent concurrent execution
    return new Promise<R>((resolve, reject) => {
      this.transactionQueue.push({ callback, resolve, reject });
      this.processTransactionQueue();
    });
  }

  /**
   * Processes the transaction queue with concurrency control
   */
  private async processTransactionQueue(): Promise<void> {
    if (this.activeTransactions >= this.MAX_CONCURRENT_TRANSACTIONS || this.transactionQueue.length === 0) {
      return;
    }

    this.activeTransactions++;
    const { callback, resolve, reject } = this.transactionQueue.shift()!;

    // Add timeout protection
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, timeoutReject) => {
      timeoutId = setTimeout(() => timeoutReject(new Error('Transaction timeout')), this.TRANSACTION_TIMEOUT);
    });

    try {
      const result = await Promise.race([
        this.adapter.runTransaction(callback),
        timeoutPromise
      ]);

      // Clear timeout since transaction completed successfully
      if (timeoutId) clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      // Clear timeout since transaction failed
      if (timeoutId) clearTimeout(timeoutId);

      Log.error(`Ganon FirestoreManager: Transaction failed: ${error}`);

      if (error instanceof SyncError) {
        reject(error);
        return;
      }

      // Check for timeout
      if (error instanceof Error && error.message === 'Transaction timeout') {
        reject(new SyncError(
          'Transaction timed out - possible deadlock or large data processing',
          SyncErrorType.SyncTimeout
        ));
        return;
      }

      // Check for specific Firestore errors
      if (error && typeof error === 'object' && 'code' in error) {
        const firestoreError = error as { code: string; message: string };

        switch (firestoreError.code) {
          case 'permission-denied':
            reject(new SyncError(
              'Permission denied for transaction',
              SyncErrorType.SyncNetworkError
            ));
            return;
          case 'unavailable':
          case 'deadline-exceeded':
            reject(new SyncError(
              'Network timeout during transaction',
              SyncErrorType.SyncTimeout
            ));
            return;
          case 'aborted':
            reject(new SyncError(
              `Transaction was aborted: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            ));
            return;
          case 'failed-precondition':
            reject(new SyncError(
              `Transaction failed due to invalid system state: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            ));
            return;
          default:
            reject(new SyncError(
              `Firestore error during transaction: ${firestoreError.message}`,
              SyncErrorType.SyncNetworkError
            ));
            return;
        }
      }

      reject(new SyncError(
        `Transaction failed: ${error}`,
        SyncErrorType.SyncFailed
      ));
    } finally {
      this.activeTransactions--;
      // Process next transaction in queue
      this.processTransactionQueue();
    }
  }

  /**
   * Backs up a value to Firestore for a given key
   * @param key - The key to backup the value for
   * @param value - The value to backup
   * @param options - Optional parameters for the backup operation
   * @returns Promise that resolves when backup is complete
   * @throws {SyncError} Throws error if backup fails
   */
  async backup(
    key: Extract<keyof T, string>,
    value: any,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    Log.verbose(`Ganon: FirestoreManager.backup, key: ${String(key)}`);

    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot perform backup operation: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (!key || key === '') {
      throw new SyncError(
        'Invalid key provided for backup operation',
        SyncErrorType.SyncValidationError
      );
    }

    // If value is undefined, treat it as a deletion
    if (value === undefined) {
      Log.info(`Ganon: value for key ${String(key)} is undefined, treating as deletion`);
      await this.delete(key);
      return;
    }

    try {
      // Pre-validate data before attempting backup
      const validation = this.dataProcessor.validateForFirestore(value);
      if (!validation.isValid) {
        Log.warn(`Firestore validation warnings for key ${String(key)}: ${validation.errors.join(', ')}`);
        // Continue anyway - let Firestore handle the errors
      }

      const { ref, type } = this.referenceManager.getRefForKey(key);

      if (type === DocumentOrCollection.Document) {
        Log.verbose(`Ganon: FirestoreManager.backup, key: ${String(key)}, type: ${type}`);
        await this._backupDocumentField(ref as FirebaseFirestoreTypes.DocumentReference, key, value, options);
      } else {
        Log.verbose(`Ganon: FirestoreManager.backup, key: ${String(key)}, type: ${type}`);
        await this._backupSubcollection(ref as FirebaseFirestoreTypes.CollectionReference, key, value, options);
      }
    } catch (error) {
      Log.error(`Ganon FirestoreManager: Backup failed for key ${String(key)}: ${error}`);

      if (error instanceof SyncError) {
        throw error;
      }

      // Check for specific Firestore errors
      if (error && typeof error === 'object' && 'code' in error) {
        const firestoreError = error as { code: string; message: string };

        switch (firestoreError.code) {
          case 'permission-denied':
            throw new SyncError(
              `Permission denied for backup operation on key ${String(key)}`,
              SyncErrorType.SyncNetworkError
            );
          case 'unavailable':
          case 'deadline-exceeded':
            throw new SyncError(
              `Network timeout during backup operation for key ${String(key)}`,
              SyncErrorType.SyncTimeout
            );
          case 'resource-exhausted':
            throw new SyncError(
              `Resource exhausted during backup operation for key ${String(key)}. Data may be too large.`,
              SyncErrorType.SyncValidationError
            );
          case 'invalid-argument':
            throw new SyncError(
              `Invalid argument provided for backup operation on key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'failed-precondition':
            throw new SyncError(
              `Operation failed due to invalid system state for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'not-found':
            throw new SyncError(
              `Document not found for backup operation on key ${String(key)}`,
              SyncErrorType.SyncValidationError
            );
          case 'already-exists':
            throw new SyncError(
              `Document already exists for backup operation on key ${String(key)}`,
              SyncErrorType.SyncConflict
            );
          case 'aborted':
            throw new SyncError(
              `Operation was aborted for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          case 'out-of-range':
            throw new SyncError(
              `Operation out of valid range for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'unimplemented':
            throw new SyncError(
              `Operation not implemented for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncConfigurationError
            );
          case 'internal':
            throw new SyncError(
              `Internal Firestore error for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          default:
            throw new SyncError(
              `Firestore error during backup for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncNetworkError
            );
        }
      }

      throw new SyncError(
        `Backup operation failed for key ${String(key)}: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Fetches a value from Firestore for a given key
   * @param key - The key to fetch the value for
   * @returns Promise that resolves with the fetched value, or undefined if not found
   * @throws {SyncError} Throws error if fetch fails
   */
  async fetch(key: Extract<keyof T, string>): Promise<T[keyof T] | undefined> {
    Log.verbose(`Ganon: FirestoreManager.fetch, key: ${String(key)}`);

    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot perform fetch operation: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (!key || key === '') {
      throw new SyncError(
        'Invalid key provided for fetch operation',
        SyncErrorType.SyncValidationError
      );
    }

    try {
      const { ref, type } = this.referenceManager.getRefForKey(key);

      if (type === DocumentOrCollection.Document) {
        const docSnap = await this.adapter.getDocument(ref as FirebaseFirestoreTypes.DocumentReference);
        if (!docSnap.exists) {
          return undefined;
        }

        const data = docSnap.data();
        if (!data) {
          return undefined;
        }

        // Try both sanitized and original key for backwards compatibility
        const keyStr = String(key);
        const sanitizedKey = this.dataProcessor.sanitizeFieldName(keyStr);

        let value = data[sanitizedKey];
        if (value === undefined && sanitizedKey !== keyStr) {
          value = data[keyStr];
        }

        if (value === undefined) {
          return undefined;
        }

        // Restore the data from Firestore format
        const restoredValue = this.dataProcessor.restoreFromFirestore(value);
        return restoredValue as T[keyof T];

      } else {
        // For subcollections, use ChunkManager to handle both chunked and non-chunked data
        const collectionRef = ref as FirebaseFirestoreTypes.CollectionReference;
        const value = await this.chunkManager.readData(collectionRef);

        if (value === undefined) {
          return undefined;
        }

        // Restore the data from Firestore format
        const restoredValue = this.dataProcessor.restoreFromFirestore(value);
        return restoredValue as T[keyof T];
      }
    } catch (error) {
      Log.error(`Ganon FirestoreManager: Fetch failed for key ${String(key)}: ${error}`);

      if (error instanceof SyncError) {
        throw error;
      }

      // Check for specific Firestore errors
      if (error && typeof error === 'object' && 'code' in error) {
        const firestoreError = error as { code: string; message: string };

        switch (firestoreError.code) {
          case 'permission-denied':
            throw new SyncError(
              `Permission denied for fetch operation on key ${String(key)}`,
              SyncErrorType.SyncNetworkError
            );
          case 'unavailable':
          case 'deadline-exceeded':
            throw new SyncError(
              `Network timeout during fetch operation for key ${String(key)}`,
              SyncErrorType.SyncTimeout
            );
          case 'invalid-argument':
            throw new SyncError(
              `Invalid argument provided for fetch operation on key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'failed-precondition':
            throw new SyncError(
              `Operation failed due to invalid system state for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'not-found':
            throw new SyncError(
              `Document not found for fetch operation on key ${String(key)}`,
              SyncErrorType.SyncValidationError
            );
          case 'aborted':
            throw new SyncError(
              `Operation was aborted for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          case 'out-of-range':
            throw new SyncError(
              `Operation out of valid range for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'unimplemented':
            throw new SyncError(
              `Operation not implemented for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncConfigurationError
            );
          case 'internal':
            throw new SyncError(
              `Internal Firestore error for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          default:
            throw new SyncError(
              `Firestore error during fetch for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncNetworkError
            );
        }
      }

      throw new SyncError(
        `Fetch operation failed for key ${String(key)}: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Deletes a value from Firestore for a given key
   * @param key - The key to delete the value for
   * @returns Promise that resolves when the deletion is complete
   * @throws {SyncError} Throws error if delete fails
   */
  async delete(key: Extract<keyof T, string>): Promise<void> {
    Log.verbose(`Ganon: FirestoreManager.delete, key: ${String(key)}`);

    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot perform delete operation: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    try {
      const { ref, type } = this.referenceManager.getRefForKey(key);

      if (type === DocumentOrCollection.Document) {
        const docRef = ref as FirebaseFirestoreTypes.DocumentReference;
        const docSnap = await this.adapter.getDocument(docRef);

        if (docSnap.exists) {
          const data = docSnap.data();
          if (data) {
            const keyStr = String(key);
            const sanitizedKey = this.dataProcessor.sanitizeFieldName(keyStr);

            // Check both sanitized and original keys
            const hasOriginalKey = data[keyStr] !== undefined;
            const hasSanitizedKey = data[sanitizedKey] !== undefined;

            if (hasOriginalKey || hasSanitizedKey) {
              const updatedData = { ...data };

              if (hasOriginalKey) {
                delete updatedData[keyStr];
              }

              if (hasSanitizedKey && sanitizedKey !== keyStr) {
                delete updatedData[sanitizedKey];
              }

              await this.adapter.setDocument(docRef, updatedData);
            }
          }
        }
      } else {
        const collRef = ref as FirebaseFirestoreTypes.CollectionReference;
        const snapshot = await this.adapter.getCollection(collRef);
        const batch = this.adapter.writeBatch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    } catch (error) {
      Log.error(`Ganon FirestoreManager: Delete failed for key ${String(key)}: ${error}`);

      if (error instanceof SyncError) {
        throw error;
      }

      // Check for specific Firestore errors
      if (error && typeof error === 'object' && 'code' in error) {
        const firestoreError = error as { code: string; message: string };

        switch (firestoreError.code) {
          case 'permission-denied':
            throw new SyncError(
              `Permission denied for delete operation on key ${String(key)}`,
              SyncErrorType.SyncNetworkError
            );
          case 'unavailable':
          case 'deadline-exceeded':
            throw new SyncError(
              `Network timeout during delete operation for key ${String(key)}`,
              SyncErrorType.SyncTimeout
            );
          case 'invalid-argument':
            throw new SyncError(
              `Invalid argument provided for delete operation on key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'failed-precondition':
            throw new SyncError(
              `Operation failed due to invalid system state for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'not-found':
            throw new SyncError(
              `Document not found for delete operation on key ${String(key)}`,
              SyncErrorType.SyncValidationError
            );
          case 'aborted':
            throw new SyncError(
              `Operation was aborted for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          case 'out-of-range':
            throw new SyncError(
              `Operation out of valid range for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncValidationError
            );
          case 'unimplemented':
            throw new SyncError(
              `Operation not implemented for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncConfigurationError
            );
          case 'internal':
            throw new SyncError(
              `Internal Firestore error for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncFailed
            );
          default:
            throw new SyncError(
              `Firestore error during delete for key ${String(key)}: ${firestoreError.message}`,
              SyncErrorType.SyncNetworkError
            );
        }
      }

      throw new SyncError(
        `Delete operation failed for key ${String(key)}: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  async dangerouslyDelete(): Promise<void> {
    if (!this.userManager.isUserLoggedIn()) {
      throw new SyncError(
        'Cannot perform dangerous delete operation: no user is logged in',
        SyncErrorType.SyncConfigurationError
      );
    }

    const currentUserId = this.userManager.getCurrentUser();
    if (!currentUserId) {
      throw new SyncError(
        'Cannot perform dangerous delete operation: user ID is not available',
        SyncErrorType.SyncConfigurationError
      );
    }

    const userRef = this.referenceManager.getUserRef();
    const backupRef = this.referenceManager.getBackupRef();

    // Log the paths we're about to delete for safety verification
    Log.info(`🗑️ Ganon FirestoreManager: Starting dangerous delete for user: ${currentUserId}`);
    Log.info(`🗑️ Ganon FirestoreManager: User document path: ${userRef.path}`);
    Log.info(`🗑️ Ganon FirestoreManager: Backup collection path: ${backupRef.path}`);

    try {
      // Always attempt to delete the user document first
      // This will cascade delete all subcollections if the document exists
      await this.adapter.deleteDocument(userRef);
      Log.info('✅ Ganon FirestoreManager: Successfully deleted user document and all subcollections');
    } catch (error) {
      Log.warn(`⚠️ Ganon FirestoreManager: Could not delete user document: ${error}`);

      // If user document deletion fails (e.g., document doesn't exist),
      // fall back to deleting the backup collection directly
      try {
        const snapshot = await this.adapter.getCollection(backupRef);
        if (snapshot.empty) {
          Log.info('✅ Ganon FirestoreManager: Backup collection is already empty');
          return;
        }

        const batch = this.adapter.writeBatch();
        let hasDeletions = false;

        snapshot.docs.forEach(doc => {
          if (doc && doc.ref) {
            batch.delete(doc.ref);
            hasDeletions = true;
          }
        });

        if (hasDeletions) {
          await batch.commit();
          Log.info(`✅ Ganon FirestoreManager: Deleted ${snapshot.size} documents from backup collection`);
        }
      } catch (fallbackError) {
        Log.error(`❌ Ganon FirestoreManager: Fallback deletion also failed: ${fallbackError}`);

        // Check for specific Firestore errors in the fallback
        if (fallbackError && typeof fallbackError === 'object' && 'code' in fallbackError) {
          const firestoreError = fallbackError as { code: string; message: string };

          switch (firestoreError.code) {
            case 'permission-denied':
              throw new SyncError(
                'Permission denied for dangerous delete operation',
                SyncErrorType.SyncNetworkError
              );
            case 'unavailable':
            case 'deadline-exceeded':
              throw new SyncError(
                'Network timeout during dangerous delete operation',
                SyncErrorType.SyncTimeout
              );
            default:
              throw new SyncError(
                `Firestore error during dangerous delete: ${firestoreError.message}`,
                SyncErrorType.SyncNetworkError
              );
          }
        }

        throw new SyncError(
          `Dangerous delete operation failed: ${fallbackError}`,
          SyncErrorType.SyncFailed
        );
      }
    }
  }

  /**
   * Backs up a single field to a Firestore document
   * @param ref - The document reference to backup to
   * @param key - The key to backup the value for
   * @param value - The value to backup
   * @param options - Optional parameters for the backup operation
   * @returns Promise that resolves when the backup is complete
   * @private
   */
  private async _backupDocumentField(
    ref: FirebaseFirestoreTypes.DocumentReference,
    key: Extract<keyof T, string>,
    value: any,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    Log.verbose(`Ganon: FirestoreManager._backupDocumentField, key: ${String(key)}`);
    const keyStr = String(key);

    // Sanitize data for Firestore using our simplified processor
    const sanitizedData = this.dataProcessor.sanitizeForFirestore(value);

    // Use sanitized field name if needed
    const sanitizedKey = this.dataProcessor.sanitizeFieldName(keyStr);

    if (sanitizedKey !== keyStr) {
      Log.warn(`Ganon FirestoreManager: Invalid field name "${keyStr}" sanitized to "${sanitizedKey}"`);
    }

    if (options?.transaction) {
      await this.adapter.setDocumentWithTransaction(options.transaction, ref, {
        [sanitizedKey]: sanitizedData
      }, {
        merge: true
      });
    } else {
      await this.adapter.setDocument(ref, {
        [sanitizedKey]: sanitizedData
      }, {
        merge: true
      });
    }

    Log.info(`Ganon FirestoreManager: Document field backup completed for key: "${sanitizedKey}"`);
  }

  /**
   * Backs up a value to a Firestore subcollection
   * @param ref - The collection reference to backup to
   * @param key - The key to backup the value for
   * @param value - The value to backup
   * @param options - Optional parameters for the backup operation
   * @returns Promise that resolves when the backup is complete
   * @private
   */
  private async _backupSubcollection(
    ref: FirebaseFirestoreTypes.CollectionReference,
    key: Extract<keyof T, string>,
    value: any,
    options?: { transaction?: FirebaseFirestoreTypes.Transaction }
  ): Promise<void> {
    Log.verbose(`Ganon: FirestoreManager._backupSubcollection, key: ${String(key)}`);

    // Sanitize data for Firestore
    const sanitizedData = this.dataProcessor.sanitizeForFirestore(value);

    // Use ChunkManager to handle large data
    await this.chunkManager.writeData(ref, String(key), sanitizedData, options);
  }
}
