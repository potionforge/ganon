/**
 * REV-7.1-006: MetadataFlushQueue must not drop pendingKeys when session guard fails after fetch.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import MetadataCoordinator from '../../metadata/remote/MetadataCoordinator';
import MetadataStore from '../../metadata/local/MetadataStore';
import StorageManager from '../../managers/StorageManager';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeScheduler } from '../utils/FakeScheduler';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';
import { SyncStatus } from '../../models/sync/SyncStatus';
import SessionToken from '../../sync/SessionToken';
import * as sessionGuard from '../../sync/sessionGuard';
import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import { REMOTE_METADATA_KEY } from '../../constants';
import {
  SixTwoStorage,
  SIX_TWO_CLOUD_CONFIG,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';

const USER = 'flush-stale-user@example.com';

describe('beta7.1 REV-006 MetadataFlushQueue stale guard', () => {
  it('re-enqueues pending keys when session goes stale after fetch', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    const scheduler = new FakeScheduler();
    const storage = new StorageManager<TestStorageMapping>(new MMKVFaker());
    const metadataStore = new MetadataStore<TestStorageMapping>(storage);

    let fetchEntered = false;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve;
    });

    const mockAdapter = {
      getDocument: jest.fn().mockImplementation(async () => {
        if (!fetchEntered) {
          fetchEntered = true;
          await fetchGate;
        }
        return { exists: true, data: () => ({}) };
      }),
      setDocument: jest.fn().mockResolvedValue(undefined),
    };

    const backupRef = { path: 'users/u1/backup' };
    const mockReferenceManager = {
      getBackupRef: jest.fn().mockReturnValue(backupRef),
      getBackupRefForUser: jest.fn().mockReturnValue(backupRef),
      getDocumentRef: jest.fn().mockReturnValue({ id: 'user', path: 'users/u1/backup/user' }),
    };

    const sessionA = SessionToken.forTests('user-1');
    const coordinator = new MetadataCoordinator(
      mockReferenceManager as any,
      mockAdapter as any,
      metadataStore,
      { isUserLoggedIn: () => true, getCurrentUser: () => 'user-1' } as any,
      'user',
      resolved,
      scheduler
    );
    coordinator.setSessionProvider(() => sessionA);

    await metadataStore.recordLocalChange('settings', {
      digest: 'pending-digest',
      version: 9,
      syncStatus: SyncStatus.Pending,
    });
    coordinator['flushQueue'].enqueue('settings');
    expect(coordinator['flushQueue'].hasPending('settings')).toBe(true);

    const flushPromise = coordinator['flushQueue'].flush();
    for (let i = 0; i < 30 && !fetchEntered; i += 1) {
      await Promise.resolve();
    }
    expect(fetchEntered).toBe(true);

    jest.spyOn(sessionGuard, 'guardSessionBeforeIo').mockReturnValue(false);
    releaseFetch();
    await flushPromise;

    expect(coordinator['flushQueue'].hasPending('settings')).toBe(true);
  });

  it('flushes pending legacy-map keys after stop() then start()', async () => {
    const config: GanonConfig<SixTwoStorage> = {
      identifierKey: 'email',
      cloudConfig: SIX_TWO_CLOUD_CONFIG,
      autoStartSync: false,
      legacyMetadataWrites: true,
    };
    const harness = createSixTwoStack(config, USER);
    harness.storage.set('email', USER);
    harness.syncEngine.mintSession(USER);
    harness.syncEngine.start();

    const realGuard = sessionGuard.guardSessionBeforeIo;
    let stalePreBuildOnce = true;
    jest.spyOn(sessionGuard, 'guardSessionBeforeIo').mockImplementation((session, label) => {
      if (label === 'MetadataFlushQueue.pre-build-updates' && stalePreBuildOnce) {
        stalePreBuildOnce = false;
        return false;
      }
      return realGuard(session, label);
    });

    await harness.metadataManager.recordLocalChange('alpha', {
      digest: computeHash('after-stop-flush'),
      version: 12,
      syncStatus: SyncStatus.Pending,
    });

    const debounceMs = resolveGanonConfig(config).metadataFlushDebounceMs;
    harness.scheduler.advance(debounceMs + 1);
    await new Promise<void>(resolve => setImmediate(resolve));

    const profileCoordinator = (harness.metadataManager as any).coordinatorRepo.getCoordinator('profile');
    expect(profileCoordinator['flushQueue'].hasPending('alpha')).toBe(true);

    harness.syncEngine.stop();
    harness.storage.set('email', USER);
    harness.syncEngine.start();
    jest.restoreAllMocks();
    await profileCoordinator.syncToRemote();

    const profileDoc = harness.fake.getDocument(harness.profileBackupPath)!;
    const legacyMap = profileDoc[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;
    expect(legacyMap.alpha).toEqual({ d: computeHash('after-stop-flush'), v: 12 });
  });
});
