/**
 * E-F3: empty maps persist on merge; subcollection [] / {} replace stale chunk_0 fields.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import { doc } from '@react-native-firebase/firestore';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreManager from '../../firestore/FirestoreManager';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeFirestore } from '../utils/FakeFirestore';
import { FakeScheduler } from '../utils/FakeScheduler';
import computeHash from '../../utils/computeHash';
import SessionToken from '../../sync/SessionToken';

interface Ef3Storage extends BaseStorageMapping {
  email: string;
  nestedDoc: unknown;
  listKey: unknown;
}

const USER = 'ef3-user';
const session = SessionToken.forTests(USER);

const config: GanonConfig<Ef3Storage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: {
      docKeys: ['nestedDoc'],
      subcollectionKeys: ['listKey'],
    },
  },
  autoStartSync: false,
  syncInterval: 60_000,
};

function createHarness(fake: FakeFirestore) {
  const storage = new StorageManager<Ef3Storage>(new MMKVFaker());
  storage.set('email', USER);
  const userManager = new UserManager<Ef3Storage>('email', storage);
  const adapter = new FirestoreAdapter(config, fake.module);
  const referenceManager = new FirestoreReferenceManager(userManager, config.cloudConfig, fake.module);
  const firestoreManager = new FirestoreManager(
    config.identifierKey,
    config.cloudConfig,
    adapter,
    userManager,
    referenceManager,
    new FakeScheduler()
  );
  return { adapter, firestoreManager, fake, userManager };
}

describe('E-F3: empty maps and replace writes', () => {
  it('nested {} persists through adapter merge write', async () => {
    const fake = new FakeFirestore();
    const { adapter } = createHarness(fake);
    const ref = doc(fake.module, 'users', USER, 'backup', 'profile');

    await adapter.setDocument(ref, { other: 'keep' }, { merge: true });
    await adapter.setDocument(ref, { nestedDoc: {} }, { merge: true });

    expect(fake.getDocument(ref.path)).toEqual({
      nestedDoc: {},
      other: 'keep',
    });
  });

  it('subcollection [] replaces prior numeric keys in chunk_0', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager } = createHarness(fake);
    const v1 = Date.now();
    await firestoreManager.backup('listKey', ['a', 'b'], {
      digest: computeHash(['a', 'b']),
      version: v1,
      session,
    });

    const collPath = `users/${USER}/backup/profile/listKey`;
    expect(fake.getDocument(`${collPath}/chunk_0`)).toEqual({ '0': 'a', '1': 'b' });

    const v2 = v1 + 1;
    await firestoreManager.backup('listKey', [], {
      digest: computeHash([]),
      version: v2,
      session,
    });

    expect(fake.getDocument(`${collPath}/chunk_0`)).toEqual({});
    expect(Object.keys(fake.getDocument(`${collPath}/chunk_0`)!)).toHaveLength(0);
  });

  it('subcollection {} replaces prior chunk_0 fields', async () => {
    const fake = new FakeFirestore();
    const { firestoreManager } = createHarness(fake);
    const v1 = Date.now();
    await firestoreManager.backup('listKey', { keep: false, drop: 'me' }, {
      digest: computeHash({ keep: false, drop: 'me' }),
      version: v1,
      session,
    });

    const collPath = `users/${USER}/backup/profile/listKey`;
    expect(fake.getDocument(`${collPath}/chunk_0`)).toEqual({ keep: false, drop: 'me' });

    const v2 = v1 + 1;
    await firestoreManager.backup('listKey', {}, {
      digest: computeHash({}),
      version: v2,
      session,
    });

    expect(fake.getDocument(`${collPath}/chunk_0`)).toEqual({});
    const read = await firestoreManager.fetch('listKey');
    expect(read).toEqual({});
  });
});
