import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import { CloudBackupConfig } from '../config/CloudBackupConfig';
import { BaseStorageMapping } from '../storage/BaseStorageMapping';
import GetRefForKeyResult from './GetRefForKeyResult';
import IUserManager from '../interfaces/IUserManager';
export default interface IFirestoreReferenceManager<T extends BaseStorageMapping> {
  readonly userManager: IUserManager;
  readonly cloudConfig: CloudBackupConfig<T>;

  /**
   * Gets a reference to the backup collection for the current user
   * @returns A reference to the backup collection for the current user
   * @throws {SyncError} If no user is logged in
   */
  getBackupRef(): FirebaseFirestoreTypes.CollectionReference;

  /**
   * Gets a reference to the user document for the current user
   * @returns A reference to the user document
   * @throws {SyncError} If no user is logged in
   */
  getUserRef(): FirebaseFirestoreTypes.DocumentReference;

  /**
   * Gets a reference to a document within the backup collection
   * @param backupRef - The reference to the backup collection
   * @param documentKey - The key of the document to get
   * @returns A reference to the document within the backup collection
   */
  getDocumentRef(
    backupRef: FirebaseFirestoreTypes.CollectionReference,
    documentKey: string
  ): FirebaseFirestoreTypes.DocumentReference;

  /**
   * Gets a reference to a subcollection within a document
   * @param documentRef - The reference to the document containing the subcollection
   * @param collectionKey - The key of the subcollection to get
   * @returns A reference to the subcollection within the document
   */
  getCollectionRef(
    documentRef: FirebaseFirestoreTypes.DocumentReference,
    collectionKey: string
  ): FirebaseFirestoreTypes.CollectionReference;

  /**
   * Looks through the cloudConfig to find the document for a given key
   * and returns a reference to it
   * @param key - The key of the document to get
   * @returns A reference to the document within the backup collection
   */
  getDocumentRefForKey(key: Extract<keyof T, string>): FirebaseFirestoreTypes.DocumentReference;

  /**
   * Gets the final reference for a given key, whether it's a document or a subcollection
   * @param key - The key of the document or subcollection to get
   * @returns A reference to the document or subcollection within the backup collection
   */
  getRefForKey(key: Extract<keyof T, string>): GetRefForKeyResult;
}
