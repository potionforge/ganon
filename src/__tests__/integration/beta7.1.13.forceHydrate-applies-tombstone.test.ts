/**
 * #13: forceHydrate applies remote delete tombstones like hydrate().
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import { DIGEST_MAP_KEY } from '../../constants';
import DeleteOperation from '../../sync/operations/DeleteOperation';
import { MMKVFaker } from '../../utils/MMKVFaker';
import {
  SixTwoStorage,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';
import { FakeFirestore } from '../utils/FakeFirestore';

const USER = 'user-force-hydrate-tombstone';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: ['alpha', 'beta'], subcollectionKeys: [] },
  },
  autoStartSync: false,
  syncInterval: 60_000,
  legacyMetadataWrites: false,
};

function seedUserStacks(userId: string) {
  const sharedFake = new FakeFirestore();
  const stackA = createSixTwoStack({ ...baseConfig }, userId, undefined, sharedFake);
  const stackB = createSixTwoStack({ ...baseConfig }, userId, new MMKVFaker(), sharedFake);
  for (const stack of [stackA, stackB]) {
    stack.storage.set('email', userId);
    stack.syncEngine.mintSession(userId);
  }
  return { sharedFake, stackA, stackB };
}

describe('#13: forceHydrate applies remote delete tombstones', () => {
  it('peer drops alpha after forceHydrate; syncAll leaves tombstone in place', async () => {
    const { sharedFake, stackA, stackB } = seedUserStacks(USER);
    const sessionA = stackA.syncEngine.captureSessionForOperation();
    const profilePath = `users/${USER}/backup/profile`;

    await stackA.firestoreManager.syncValueWithDigest(
      'alpha',
      'alpha-remote',
      computeHash('alpha-remote'),
      1,
      sessionA
    );

    await stackB.syncEngine.restore();
    expect(stackB.storage.get('alpha')).toBe('alpha-remote');

    await new DeleteOperation(
      'alpha',
      stackA.storage,
      stackA.firestoreManager,
      stackA.metadataManager,
      sessionA
    ).execute();

    const tombstone = (sharedFake.getDocument(profilePath)![DIGEST_MAP_KEY] as Record<
      string,
      { d: string; v: number }
    >).alpha;
    expect(tombstone).toEqual({ d: '', v: expect.any(Number) });

    await stackB.metadataManager.invalidateCache('alpha');
    await stackB.syncEngine.forceHydrate(['alpha']);
    expect(stackB.storage.get('alpha')).toBeUndefined();
    expect(stackB.metadataManager.get('alpha')!.digest).toBe('');

    await stackB.syncEngine.syncAll();
    const docAfterSyncAll = sharedFake.getDocument(profilePath)!;
    expect(docAfterSyncAll.alpha).toBeUndefined();
    expect((docAfterSyncAll[DIGEST_MAP_KEY] as Record<string, unknown>).alpha).toEqual(tombstone);
  });
});
