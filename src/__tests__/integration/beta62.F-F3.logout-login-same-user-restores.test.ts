/**
 * beta62.F-F3: after logout({ backup: false }), login(sameUser) must restore, not noop.
 * Mock stack aligned with beta62.C-F2 (jest-mocked FirestoreAdapter + in-memory store).
 */
import Ganon from '../../Ganon';
import { MOCK_CLOUD_BACKUP_CONFIG, TestStorageMapping } from '../../__mocks__/MockConfig';
import { MockFirestoreAdapter } from '../../__mocks__/MockFirestoreAdapter';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import { FirebaseFirestoreTypes } from '@react-native-firebase/firestore';
import IFirestoreAdapter from '../../models/interfaces/IFirestoreAdapter';
import * as FirestoreModule from '@react-native-firebase/firestore';

class InMemoryFirestoreAdapter extends MockFirestoreAdapter implements IFirestoreAdapter {
  async getCollection(
    ref: FirebaseFirestoreTypes.CollectionReference
  ): Promise<FirebaseFirestoreTypes.QuerySnapshot> {
    const prefix = `${ref.path}/`;
    const docs = Array.from(this.getAllDocuments().entries())
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, docData]) => {
        const id = path.slice(prefix.length);
        const docRef = { id, path } as FirebaseFirestoreTypes.DocumentReference;
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

    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      metadata: { fromCache: false, hasPendingWrites: false },
      forEach: (callback: (doc: FirebaseFirestoreTypes.DocumentSnapshot) => void) => {
        docs.forEach(callback);
      },
    } as FirebaseFirestoreTypes.QuerySnapshot;
  }
}

const memoryStore = new InMemoryFirestoreAdapter();

jest.mock('../../firestore/FirestoreAdapter', () =>
  jest.fn().mockImplementation(() => ({
    getDocument: (ref: FirebaseFirestoreTypes.DocumentReference) => memoryStore.getDocument(ref),
    setDocument: (
      ref: FirebaseFirestoreTypes.DocumentReference,
      data: unknown,
      options?: FirebaseFirestoreTypes.SetOptions
    ) => memoryStore.setDocument(ref, data, options),
    updateDocument: (ref: FirebaseFirestoreTypes.DocumentReference, data: unknown) =>
      memoryStore.updateDocument(ref, data),
    deleteDocument: (ref: FirebaseFirestoreTypes.DocumentReference) => memoryStore.deleteDocument(ref),
    getCollection: (ref: FirebaseFirestoreTypes.CollectionReference) => memoryStore.getCollection(ref),
    runTransaction: <T>(fn: (tx: FirebaseFirestoreTypes.Transaction) => Promise<T>) =>
      memoryStore.runTransaction(fn),
    writeBatch: () => memoryStore.writeBatch(),
    setDocumentWithTransaction: (
      tx: FirebaseFirestoreTypes.Transaction,
      ref: FirebaseFirestoreTypes.DocumentReference,
      data: unknown,
      options?: FirebaseFirestoreTypes.SetOptions
    ) => memoryStore.setDocumentWithTransaction(tx, ref, data, options),
    updateDocumentWithTransaction: (
      tx: FirebaseFirestoreTypes.Transaction,
      ref: FirebaseFirestoreTypes.DocumentReference,
      data: unknown
    ) => memoryStore.updateDocumentWithTransaction(tx, ref, data),
    deleteDocumentWithTransaction: (
      tx: FirebaseFirestoreTypes.Transaction,
      ref: FirebaseFirestoreTypes.DocumentReference
    ) => memoryStore.deleteDocumentWithTransaction(tx, ref),
    getDocumentWithTransaction: (
      tx: FirebaseFirestoreTypes.Transaction,
      ref: FirebaseFirestoreTypes.DocumentReference
    ) => memoryStore.getDocumentWithTransaction(tx, ref),
  }))
);

jest.mock('../../firestore/ref/FirestoreReferenceManager', () =>
  jest.requireActual('../../firestore/ref/FirestoreReferenceManager')
);

describe('beta62.F-F3 logout then login same user restores', () => {
  const USER_ID = 'u1';

  beforeEach(() => {
    memoryStore.clear();
    FirestoreModule.clearMockStore();

    jest.spyOn(FirestoreModule, 'collection').mockImplementation((parent: unknown, ...segments: string[]) => {
      const basePath =
        typeof parent === 'object' && parent !== null && 'path' in parent
          ? (parent as { path: string }).path
          : String(parent);
      const fullPath = [basePath, ...segments].filter(Boolean).join('/');
      return {
        path: fullPath,
        id: segments[segments.length - 1] ?? fullPath.split('/').pop() ?? '',
        doc: (id: string) => {
          const docPath = `${fullPath}/${id}`;
          return { path: docPath, id } as FirebaseFirestoreTypes.DocumentReference;
        },
      } as FirebaseFirestoreTypes.CollectionReference;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('login → logout({ backup: false }) → login(same user) chooses restore', async () => {
    jest.useFakeTimers();

    const ganon = new Ganon<TestStorageMapping>({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
      autoStartSync: false,
      logLevel: 0,
    });

    try {
      ganon.set('user', { id: USER_ID, name: 'Test', email: 'u1@example.com' });
      ganon.set('count', 7);

      const firstLogin = await ganon.login(USER_ID);
      expect(firstLogin.action).toBe('backup');

      // MetadataCoordinator debounces remote metadata flush (1s); drain before logout
      // so probe tenure exists — no extra Ganon API calls between logout and re-login.
      await jest.advanceTimersByTimeAsync(1500);
      await Promise.resolve();

      await ganon.logout({ backup: false });

      const secondLogin = await ganon.login(USER_ID);
      expect(secondLogin.action).toBe('restore');
      expect(secondLogin.action).not.toBe('noop');
    } finally {
      ganon.destroy();
      jest.useRealTimers();
    }
  });
});
