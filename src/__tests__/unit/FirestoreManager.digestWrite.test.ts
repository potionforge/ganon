import FirestoreManager from '../../firestore/FirestoreManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { MOCK_CLOUD_BACKUP_CONFIG, TestStorageMapping } from '../../__mocks__/MockConfig';
import { clearMockStore, getFirestore, getMockStore } from '@react-native-firebase/firestore';
import { DIGEST_MAP_KEY } from '../../constants';
import { FakeScheduler } from '../utils/FakeScheduler';

function createFirestoreManager(storage: StorageManager<TestStorageMapping>) {
  const userManager = new UserManager<TestStorageMapping>('email', storage);
  const cloudConfig = MOCK_CLOUD_BACKUP_CONFIG;
  const firestoreModule = getFirestore();
  const adapter = new FirestoreAdapter<TestStorageMapping>(
    { identifierKey: 'email', cloudConfig },
    firestoreModule
  );
  const referenceManager = new FirestoreReferenceManager<TestStorageMapping>(
    userManager,
    cloudConfig,
    firestoreModule
  );
  const firestoreManager = new FirestoreManager<TestStorageMapping>(
    'email',
    cloudConfig,
    adapter,
    userManager,
    referenceManager,
    new FakeScheduler()
  );
  return { firestoreManager, referenceManager };
}

describe('FirestoreManager digest writes', () => {
  beforeEach(() => {
    clearMockStore();
  });

  it('writes digestMap as a nested map on doc-field keys (not a dotted literal field name)', async () => {
    const kv = new MMKVFaker();
    const storage = new StorageManager<TestStorageMapping>(kv);
    storage.set('email', 'user-1');
    const { firestoreManager, referenceManager } = createFirestoreManager(storage);

    await firestoreManager.syncValueWithDigest('count', 42, 'abc123', 99);

    const docPath = referenceManager.getDocumentRefForKey('count').path;
    const raw = getMockStore().get(docPath);

    expect(raw[DIGEST_MAP_KEY]).toEqual({
      count: { d: 'abc123', v: 99 },
    });
    expect(raw[`${DIGEST_MAP_KEY}.count`]).toBeUndefined();
    expect(raw.count).toBe(42);
  });

  it('writes parent-document digest for subcollection keys (§4.5)', async () => {
    const kv = new MMKVFaker();
    const storage = new StorageManager<TestStorageMapping>(kv);
    storage.set('email', 'user-1');
    const { firestoreManager, referenceManager } = createFirestoreManager(storage);

    await firestoreManager.syncValueWithDigest('settings', { theme: 'dark' }, 'sub-digest', 7);

    const parentDocPath = referenceManager.getDocumentRefForKey('settings').path;
    const raw = getMockStore().get(parentDocPath);

    expect(raw[DIGEST_MAP_KEY]).toEqual({
      settings: { d: 'sub-digest', v: 7 },
    });
    expect(raw[`${DIGEST_MAP_KEY}.settings`]).toBeUndefined();
    expect(raw.settings).toBeUndefined();

    const { ref } = referenceManager.getRefForKey('settings');
    const chunkPath = `${ref.path}/chunk_0`;
    expect(getMockStore().get(chunkPath)).toMatchObject({ theme: 'dark' });
  });
});
