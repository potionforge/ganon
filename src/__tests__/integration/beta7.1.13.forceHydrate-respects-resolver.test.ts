/**
 * #13: forceHydrate must honor conflict resolution (no fall-through to remote-wins write).
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
import { ConflictResolutionStrategy } from '../../models/config/ConflictResolutionStrategy';
import { ConflictMergeStrategy } from '../../models/config/ConflictMergeStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';
import computeHash from '../../utils/computeHash';
import {
  SixTwoStorage,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';

const USER = 'user-force-hydrate-resolver';

const cloudConfig: GanonConfig<SixTwoStorage>['cloudConfig'] = {
  profile: { docKeys: ['alpha', 'beta'], subcollectionKeys: [] },
};

describe('#13: forceHydrate respects conflict resolver', () => {
  it('LOCAL_WINS keeps local alpha and local digest metadata', async () => {
    const harness = createSixTwoStack(
      {
        identifierKey: 'email',
        cloudConfig,
        autoStartSync: false,
        syncInterval: 60_000,
        conflictResolutionConfig: { strategy: ConflictResolutionStrategy.LOCAL_WINS },
      },
      USER
    );
    harness.storage.set('email', USER);
    harness.syncEngine.mintSession(USER);
    const session = harness.syncEngine.captureSessionForOperation();

    const localAlpha = 'local-alpha';
    const remoteAlpha = 'remote-alpha';
    harness.storage.set('alpha', localAlpha);
    await harness.metadataManager.recordSyncedState('alpha', {
      syncStatus: SyncStatus.Synced,
      digest: computeHash(localAlpha),
      version: 10,
    });

    await harness.firestoreManager.syncValueWithDigest(
      'alpha',
      remoteAlpha,
      computeHash(remoteAlpha),
      20,
      session
    );

    await harness.metadataManager.invalidateCache('alpha');
    const result = await harness.syncEngine.forceHydrate(['alpha']);
    expect(result.success).toBe(true);
    expect(harness.storage.get('alpha')).toBe(localAlpha);
    expect(harness.metadataManager.get('alpha')!.digest).toBe(computeHash(localAlpha));
    expect(harness.metadataManager.get('alpha')!.digest).not.toBe(computeHash(remoteAlpha));
  });

  it('DEEP_MERGE applies merged object, not the remote value alone', async () => {
    const harness = createSixTwoStack(
      {
        identifierKey: 'email',
        cloudConfig,
        autoStartSync: false,
        syncInterval: 60_000,
        conflictResolutionConfig: {
          strategy: ConflictResolutionStrategy.LOCAL_WINS,
          mergeStrategy: ConflictMergeStrategy.DEEP_MERGE,
        },
      },
      USER
    );
    harness.storage.set('email', USER);
    harness.syncEngine.mintSession(USER);
    const session = harness.syncEngine.captureSessionForOperation();

    const localObj = { tag: 'local', onlyLocal: true };
    const remoteObj = { tag: 'remote', onlyRemote: true };
    const merged = { tag: 'local', onlyLocal: true, onlyRemote: true };

    harness.storage.set('alpha', localObj as unknown as SixTwoStorage['alpha']);
    await harness.metadataManager.recordSyncedState('alpha', {
      syncStatus: SyncStatus.Synced,
      digest: computeHash(localObj),
      version: 5,
    });

    await harness.firestoreManager.syncValueWithDigest(
      'alpha',
      remoteObj,
      computeHash(remoteObj),
      15,
      session
    );

    await harness.metadataManager.invalidateCache('alpha');
    await harness.syncEngine.forceHydrate(['alpha']);

    expect(harness.storage.get('alpha')).toEqual(merged);
    expect(harness.storage.get('alpha')).not.toEqual(remoteObj);
    expect(harness.metadataManager.get('alpha')!.digest).toBe(computeHash(merged));
  });
});
