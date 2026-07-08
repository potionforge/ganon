import {
  collection,
  doc,
  getFirestore,
  FirebaseFirestoreTypes,
} from '@react-native-firebase/firestore';
import SyncError, { SyncErrorType } from '../../errors/SyncError';
import { CloudBackupConfig } from '../../models/config/CloudBackupConfig';
import DocumentOrCollection from '../../models/firestore/DocumentOrCollection';
import GetRefForKeyResult from '../../models/firestore/GetRefForKeyResult';
import IFirestoreReferenceManager from '../../models/firestore/IFirestoreReferenceManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import IUserManager from '../../models/interfaces/IUserManager';
import Log from '../../utils/Log';
import KeyRouter from '../../routing/KeyRouter';

export default class FirestoreReferenceManager<T extends BaseStorageMapping> implements IFirestoreReferenceManager<T> {
  private firestore: FirebaseFirestoreTypes.Module;

  constructor(
    public userManager: IUserManager,
    public cloudConfig: CloudBackupConfig<T>,
    keyRouter?: KeyRouter<T>,
    firestore?: FirebaseFirestoreTypes.Module
  ) {
    this.keyRouter = keyRouter ?? new KeyRouter(cloudConfig);
    this.firestore = firestore ?? getFirestore();
  }

  private keyRouter: KeyRouter<T>;

  /**
   * Gets a reference to the backup collection for the current user
   * @returns A reference to the backup collection for the current user
   * @throws {SyncError} If no user is logged in
   */
  getBackupRef(): FirebaseFirestoreTypes.CollectionReference {
    const identifier = this.userManager.getCurrentUser();
    Log.verbose(`🔥 FirestoreReferenceManager.getBackupRef called with identifier: ${identifier}`);

    if (!identifier) {
      throw new SyncError(
        'Cannot get backup reference: no user is logged in',
        SyncErrorType.SyncConfigurationError
      )
    }
    const userRef = doc(this.firestore, 'users', identifier);
    Log.verbose(`🔥 userRef path: ${userRef.path}`);

    const backupRef = collection(userRef, 'backup');
    Log.verbose(`🔥 backupRef path: ${backupRef.path}`);
    Log.verbose(`🔥 backupRef id: ${backupRef.id}`);

    return backupRef;
  }

  /**
   * Gets a reference to the user document for the current user
   * @returns A reference to the user document
   * @throws {SyncError} If no user is logged in
   */
  getUserRef(): FirebaseFirestoreTypes.DocumentReference {
    const identifier = this.userManager.getCurrentUser();
    Log.verbose(`🔥 FirestoreReferenceManager.getUserRef called with identifier: ${identifier}`);

    if (!identifier) {
      throw new SyncError(
        'Cannot get user reference: no user is logged in',
        SyncErrorType.SyncConfigurationError
      )
    }
    const userRef = doc(this.firestore, 'users', identifier);
    Log.verbose(`🔥 userRef path: ${userRef.path}`);

    return userRef;
  }

  /**
   * Gets a reference to a document within the backup collection
   * @param backupRef - The reference to the backup collection
   * @param documentKey - The key of the document to get
   * @returns A reference to the document within the backup collection
   */
  getDocumentRef(backupRef: FirebaseFirestoreTypes.CollectionReference, documentKey: string): FirebaseFirestoreTypes.DocumentReference {
    return doc(backupRef, documentKey);
  }

  /**
   * Gets a reference to a subcollection within a document
   * @param documentRef - The reference to the document containing the subcollection
   * @param collectionKey - The key of the subcollection to get
   * @returns A reference to the subcollection within the document
   */
  getCollectionRef(documentRef: FirebaseFirestoreTypes.DocumentReference, collectionKey: string): FirebaseFirestoreTypes.CollectionReference {
    return collection(documentRef, collectionKey);
  }

  /**
   * Looks through the cloudConfig to find the document or subcollection for a given key
   * and returns a reference to it
   * @param key - The key of the document or subcollection to get
   * @returns A reference to the document or subcollection within the backup collection
   */
  getDocumentRefForKey(key: Extract<keyof T, string>): FirebaseFirestoreTypes.DocumentReference {
    const route = this._requireRoute(key);
    return this.getDocumentRef(this.getBackupRef(), route.document);
  }

  getRefForKey(key: Extract<keyof T, string>): GetRefForKeyResult {
    const route = this._requireRoute(key);
    const backupRef = this.getBackupRef();
    const docRef = this.getDocumentRef(backupRef, route.document);

    if (route.kind === 'docField') {
      return { ref: docRef, type: DocumentOrCollection.Document };
    }
    return {
      ref: this.getCollectionRef(docRef, key),
      type: DocumentOrCollection.Collection,
    };
  }

  /* P R I V A T E */

  private _requireRoute(key: Extract<keyof T, string>) {
    const route = this.keyRouter.route(key);
    if (!route) {
      throw new Error(`Ganon: key ${key} not found in cloudConfig`);
    }
    return route;
  }
}