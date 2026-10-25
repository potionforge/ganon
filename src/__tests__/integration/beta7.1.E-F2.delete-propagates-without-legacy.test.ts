/**
 * E-F2 follow-on: in-document digest tombstones (legacyMetadataWrites: false) propagate deletes.
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

const USER = 'user-delete-propagate';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: ['alpha', 'beta'], subcollectionKeys: [] },
  },
  autoStartSync: false,
  syncInterval: 60_000,
  legacyMetadataWrites: false,
};

function seedUserStacks(userId: string, cloudConfig: GanonConfig<SixTwoStorage>['cloudConfig']) {
  const sharedFake = new FakeFirestore();
  const config = { ...baseConfig, cloudConfig };
  const stackA = createSixTwoStack(config, userId, undefined, sharedFake);
  const stackB = createSixTwoStack(config, userId, new MMKVFaker(), sharedFake);
  for (const stack of [stackA, stackB]) {
    stack.storage.set('email', userId);
    stack.syncEngine.mintSession(userId);
  }
  return { sharedFake, stackA, stackB };
}

describe('E-F2: delete tombstone propagates without legacy metadata writes', () => {
  it('docKey: remote tombstone removes peer local value on hydrate; syncAll does not restore', async () => {
    const { sharedFake, stackA, stackB } = seedUserStacks(USER, baseConfig.cloudConfig);
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

    const deleteOp = new DeleteOperation(
      'alpha',
      stackA.storage,
      stackA.firestoreManager,
      stackA.metadataManager,
      sessionA
    );
    await deleteOp.execute();

    const remoteDocAfterDelete = sharedFake.getDocument(profilePath)!;
    const tombstone = (remoteDocAfterDelete[DIGEST_MAP_KEY] as Record<string, { d: string; v: number }>)
      .alpha;
    expect(tombstone).toEqual({ d: '', v: expect.any(Number) });

    await stackB.metadataManager.invalidateCache('alpha');
    await stackB.syncEngine.hydrate(['alpha']);
    expect(stackB.storage.get('alpha')).toBeUndefined();

    await stackB.syncEngine.syncAll();
    const docAfterSyncAll = sharedFake.getDocument(profilePath)!;
    expect(docAfterSyncAll.alpha).toBeUndefined();
    expect((docAfterSyncAll[DIGEST_MAP_KEY] as Record<string, unknown>).alpha).toEqual(tombstone);
  });

  it('restore on a tombstoned key: skipped not failed, seeds local tombstone metadata', async () => {
    const { sharedFake, stackA } = seedUserStacks(`${USER}-restore`, baseConfig.cloudConfig);
    const sessionA = stackA.syncEngine.captureSessionForOperation();
    const profilePath = `users/${USER}-restore/backup/profile`;

    await stackA.firestoreManager.syncValueWithDigest(
      'alpha',
      'gone',
      computeHash('gone'),
      1,
      sessionA
    );
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

    const stackC = createSixTwoStack(
      { ...baseConfig, cloudConfig: baseConfig.cloudConfig },
      `${USER}-restore`,
      new MMKVFaker(),
      sharedFake
    );
    stackC.storage.set('email', `${USER}-restore`);
    stackC.syncEngine.mintSession(`${USER}-restore`);

    const restoreResult = await stackC.syncEngine.restore();
    expect(restoreResult.failedKeys).not.toContain('alpha');
    expect(restoreResult.restoredKeys).not.toContain('alpha');
    expect(stackC.storage.get('alpha')).toBeUndefined();
    expect(stackC.metadataManager.get('alpha')).toEqual(
      expect.objectContaining({ digest: '', version: tombstone.v, syncStatus: expect.anything() })
    );
  });

  it('subcollection: tombstone on parent doc propagates the same way', async () => {
    const subConfig: GanonConfig<SixTwoStorage>['cloudConfig'] = {
      profile: { docKeys: [], subcollectionKeys: ['alpha'] },
    };
    const { sharedFake, stackA, stackB } = seedUserStacks(`${USER}-sub`, subConfig);
    const sessionA = stackA.syncEngine.captureSessionForOperation();
    const profilePath = `users/${USER}-sub/backup/profile`;

    await stackA.firestoreManager.syncValueWithDigest(
      'alpha',
      'sub-alpha',
      computeHash('sub-alpha'),
      1,
      sessionA
    );

    await stackB.syncEngine.restore();
    expect(stackB.storage.get('alpha')).toEqual({ value: 'sub-alpha' });

    const deleteOp = new DeleteOperation(
      'alpha',
      stackA.storage,
      stackA.firestoreManager,
      stackA.metadataManager,
      sessionA
    );
    await deleteOp.execute();

    const remoteDocAfterDelete = sharedFake.getDocument(profilePath)!;
    const tombstone = (remoteDocAfterDelete[DIGEST_MAP_KEY] as Record<string, { d: string; v: number }>)
      .alpha;
    expect(tombstone).toEqual({ d: '', v: expect.any(Number) });

    await stackB.metadataManager.invalidateCache('alpha');
    await stackB.syncEngine.hydrate(['alpha']);
    expect(stackB.storage.get('alpha')).toBeUndefined();

    await stackB.syncEngine.syncAll();
    const docAfterSyncAll = sharedFake.getDocument(profilePath)!;
    expect((docAfterSyncAll[DIGEST_MAP_KEY] as Record<string, unknown>).alpha).toEqual(tombstone);
    expect(await stackB.firestoreManager.fetch('alpha')).toBeUndefined();
  });
});
