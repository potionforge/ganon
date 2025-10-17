import {
  FirebaseFirestoreTypes
} from '@react-native-firebase/firestore';

export default interface IFirestoreAdapter {
  getDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot>;
  setDocument(ref: FirebaseFirestoreTypes.DocumentReference, data: any, options?: FirebaseFirestoreTypes.SetOptions): Promise<void>;
  updateDocument(ref: FirebaseFirestoreTypes.DocumentReference, data: any): Promise<void>;
  deleteDocument(ref: FirebaseFirestoreTypes.DocumentReference): Promise<void>;
  getCollection(ref: FirebaseFirestoreTypes.CollectionReference): Promise<FirebaseFirestoreTypes.QuerySnapshot>;
  runTransaction<T>(updateFunction: (transaction: FirebaseFirestoreTypes.Transaction) => Promise<T>): Promise<T>;
  writeBatch(): FirebaseFirestoreTypes.WriteBatch;

  // Transaction methods
  setDocumentWithTransaction(transaction: FirebaseFirestoreTypes.Transaction, ref: FirebaseFirestoreTypes.DocumentReference, data: any, options?: FirebaseFirestoreTypes.SetOptions): Promise<void>;
  updateDocumentWithTransaction(transaction: FirebaseFirestoreTypes.Transaction, ref: FirebaseFirestoreTypes.DocumentReference, data: any): Promise<void>;
  deleteDocumentWithTransaction(transaction: FirebaseFirestoreTypes.Transaction, ref: FirebaseFirestoreTypes.DocumentReference): Promise<void>;
  getDocumentWithTransaction(transaction: FirebaseFirestoreTypes.Transaction, ref: FirebaseFirestoreTypes.DocumentReference): Promise<FirebaseFirestoreTypes.DocumentSnapshot>;
}
