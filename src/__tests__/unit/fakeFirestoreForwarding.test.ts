import { collection, doc } from '@react-native-firebase/firestore';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { GanonConfig } from '../../models/config/GanonConfig';
import { FakeFirestore } from '../utils/FakeFirestore';

jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

jest.mock('@react-native-firebase/firestore');

interface TestStorageMapping extends BaseStorageMapping {
  testKey1: string;
  nestedKey: string;
}

const createTestConfig = (): GanonConfig<TestStorageMapping> => ({
  identifierKey: 'testKey1',
  cloudConfig: {
    settings: {
      docKeys: ['testKey1', 'nestedKey'],
      subcollectionKeys: [],
    },
  } as GanonConfig<TestStorageMapping>['cloudConfig'],
  remoteReadonly: false,
});

describe('FakeFirestore forwarding through production adapter', () => {
  it('round-trips setDocument/getDocument through FirestoreAdapter into FakeFirestore', async () => {
    const fake = new FakeFirestore();
    const adapter = new FirestoreAdapter(createTestConfig(), fake.module);
    const ref = doc(fake.module, 'users', 'alice', 'settings', 'profile');

    await adapter.setDocument(ref, { name: 'Alice', score: 42 });

    expect(fake.getDocument('users/alice/settings/profile')).toEqual({ name: 'Alice', score: 42 });

    const snapshot = await adapter.getDocument(ref);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.data()).toEqual({ name: 'Alice', score: 42 });
  });

  it('propagates owner through derived refs built by FirestoreReferenceManager', async () => {
    const fake = new FakeFirestore();
    const adapter = new FirestoreAdapter(createTestConfig(), fake.module);
    const refManager = new FirestoreReferenceManager(
      { getCurrentUser: () => 'alice' },
      createTestConfig().cloudConfig,
      fake.module
    );

    const { ref } = refManager.getRefForKey('testKey1');
    await adapter.setDocument(ref, { routed: true });

    expect(fake.getDocument('users/alice/backup/settings')).toEqual({ routed: true });

    const root = doc(fake.module, 'users', 'alice');
    const backup = collection(root, 'backup');
    const derived = doc(backup, 'settings');
    expect(fake.getDocument(derived.path)).toEqual({ routed: true });
  });

  it('buffers transaction writes through FirestoreAdapter.runTransaction into FakeFirestore', async () => {
    const fake = new FakeFirestore();
    const adapter = new FirestoreAdapter(createTestConfig(), fake.module);
    const ref = doc(fake.module, 'users', 'bob', 'ledger', 'entry1');

    await adapter.runTransaction(async tx => {
      await adapter.setDocumentWithTransaction(tx, ref, { amount: 100, status: 'pending' });
      await adapter.updateDocumentWithTransaction(tx, ref, { status: 'posted' });
    });

    expect(fake.getDocument('users/bob/ledger/entry1')).toEqual({ amount: 100, status: 'posted' });
  });

  it('setDocument merge preserves sibling keys in nested digestMap', async () => {
    const fake = new FakeFirestore();
    const adapter = new FirestoreAdapter(createTestConfig(), fake.module);
    const ref = doc(fake.module, 'users', 'alice', 'backup', 'settings');

    await adapter.setDocument(
      ref,
      { key1: { foo: 1 }, digestMap: { key1: { d: 'hash1', v: 1 } } },
      { merge: true }
    );
    await adapter.setDocument(
      ref,
      { key2: { bar: 2 }, digestMap: { key2: { d: 'hash2', v: 1 } } },
      { merge: true }
    );

    expect(fake.getDocument(ref.path)).toEqual({
      key1: { foo: 1 },
      key2: { bar: 2 },
      digestMap: {
        key1: { d: 'hash1', v: 1 },
        key2: { d: 'hash2', v: 1 },
      },
    });
  });

  it('isolates two FakeFirestore instances — writes through one never appear in the other', async () => {
    const fake1 = new FakeFirestore();
    const fake2 = new FakeFirestore();
    const adapter1 = new FirestoreAdapter(createTestConfig(), fake1.module);
    const adapter2 = new FirestoreAdapter(createTestConfig(), fake2.module);

    const ref1 = doc(fake1.module, 'tenants', 'a', 'data', 'doc');
    const ref2 = doc(fake2.module, 'tenants', 'a', 'data', 'doc');

    await adapter1.setDocument(ref1, { tenant: 'a', secret: 'only-in-fake1' });
    await adapter2.setDocument(ref2, { tenant: 'a', secret: 'only-in-fake2' });

    expect(fake1.getDocument('tenants/a/data/doc')).toEqual({ tenant: 'a', secret: 'only-in-fake1' });
    expect(fake2.getDocument('tenants/a/data/doc')).toEqual({ tenant: 'a', secret: 'only-in-fake2' });
    expect(fake1.getDocument('tenants/a/data/doc')).not.toEqual(fake2.getDocument('tenants/a/data/doc'));
  });
});
