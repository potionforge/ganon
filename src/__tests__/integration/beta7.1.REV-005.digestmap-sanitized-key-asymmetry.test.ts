/**
 * REV-7.1-005: digestMap tombstones must use the sanitized key only (same as syncValueWithDigest).
 * A raw-key tombstone left after delete makes _mergeDigestSources prefer stale delete over a new set.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { DIGEST_MAP_KEY } from '../../constants';
import computeHash from '../../utils/computeHash';
import { GanonConfig, InternalGanonConfig } from '../../models/config/GanonConfig';
import DeleteOperation from '../../sync/operations/DeleteOperation';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeFirestore } from '../utils/FakeFirestore';
import { createSixTwoStack } from '../utils/sixTwoIntegrationHarness';

interface DotKeyStorage extends BaseStorageMapping {
  email: string;
  'alpha.beta': string;
}

const RAW_KEY = 'alpha.beta';
const USER = 'sanitized-key-user';

const config: GanonConfig<DotKeyStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: [RAW_KEY], subcollectionKeys: [] },
  },
  autoStartSync: false,
  legacyMetadataWrites: false,
};

function seedStacks(userId: string) {
  const sharedFake = new FakeFirestore();
  const internalConfig = config as InternalGanonConfig<DotKeyStorage>;
  const stackA = createSixTwoStack(internalConfig as InternalGanonConfig<any>, userId, undefined, sharedFake);
  const stackB = createSixTwoStack(internalConfig as InternalGanonConfig<any>, userId, new MMKVFaker(), sharedFake);
  for (const stack of [stackA, stackB]) {
    stack.storage.set('email', userId);
    stack.syncEngine.mintSession(userId);
  }
  return { sharedFake, stackA, stackB, profilePath: `users/${userId}/backup/profile` };
}

describe('beta7.1 REV-005 digestMap sanitized key on delete', () => {
  it('does not leave a raw-key digest tombstone when sanitized differs', async () => {
    const { stackA, profilePath } = seedStacks(USER);
    const session = stackA.syncEngine.captureSessionForOperation();

    await stackA.firestoreManager.syncValueWithDigest(
      RAW_KEY as any,
      'v1',
      computeHash('v1'),
      1,
      session
    );

    const digestMap = stackA.fake.getDocument(profilePath)![DIGEST_MAP_KEY] as Record<
      string,
      { d: string; v: number }
    >;
    expect(digestMap[RAW_KEY]).toBeUndefined();
    expect(digestMap['alpha_beta']).toEqual({ d: computeHash('v1'), v: 1 });
  });

  it('set → delete → set again: peer hydrate keeps the new value', async () => {
    const { sharedFake, stackA, stackB, profilePath } = seedStacks(USER);
    const sessionA = stackA.syncEngine.captureSessionForOperation();

    await stackA.firestoreManager.syncValueWithDigest(
      RAW_KEY as any,
      'first',
      computeHash('first'),
      1,
      sessionA
    );

    await stackB.syncEngine.restore();
    expect(stackB.storage.get(RAW_KEY as any)).toBe('first');

    const deleteOp = new DeleteOperation(
      RAW_KEY as any,
      stackA.storage,
      stackA.firestoreManager,
      stackA.metadataManager,
      sessionA
    );
    await deleteOp.execute();

    const digestAfterDelete = (sharedFake.getDocument(profilePath)![DIGEST_MAP_KEY] ?? {}) as Record<
      string,
      { d: string; v: number }
    >;
    expect(digestAfterDelete[RAW_KEY]).toBeUndefined();
    expect(digestAfterDelete['alpha_beta']?.d).toBe('');

    await stackA.firestoreManager.syncValueWithDigest(
      RAW_KEY as any,
      'second',
      computeHash('second'),
      5,
      sessionA
    );

    await stackB.metadataManager.invalidateCache(RAW_KEY as any);
    await stackB.syncEngine.hydrate([RAW_KEY as any]);

    expect(stackB.storage.get(RAW_KEY as any)).toBe('second');
  });
});
