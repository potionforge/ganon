/**
 * Finding: C-F1   Severity: High
 * Mechanism: RemoteMetadataCache._getDocRef and MetadataFlushQueue._getDocRef memoize the per-user
 *   backup document ref (derived from userManager.getCurrentUser()) on first use and nothing in
 *   invalidate()/cancelAll()/cancelPendingOperations() resets it, so after logout(A) -> login(B) in
 *   the same process B's remote-metadata reads hit A's document and B's legacy-map flush writes into
 *   A's document.
 * Targets: src/metadata/remote/RemoteMetadataCache.ts:98-104 (docRef memo, read side)
 *          src/metadata/remote/MetadataFlushQueue.ts:98-104 (docRef memo, write side)
 *          src/metadata/remote/RemoteMetadataCache.ts:74-81 (invalidate() does not reset docRef)
 *          src/metadata/remote/MetadataFlushQueue.ts:72-78 (cancelAll() does not reset docRef)
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import { SyncStatus } from '../../models/sync/SyncStatus';
import computeHash from '../../utils/computeHash';
import { REMOTE_METADATA_KEY } from '../../constants';
import {
  SIX_TWO_CLOUD_CONFIG,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../../__tests__/utils/sixTwoIntegrationHarness';

const USER_A = 'user-a@example.com';
const USER_B = 'user-b@example.com';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
};

let harness = createSixTwoStack(baseConfig, USER_A);

jest.mock('../../factory/DependencyFactory', () =>
  jest.fn().mockImplementation(() => ({
    getDependencies: () => ({
      storageManager: harness.storage,
      syncEngine: harness.syncEngine,
      firestoreManager: harness.firestoreManager,
      networkMonitor: harness.networkMonitor,
      userManager: harness.userManager,
      keyRouter: harness.keyRouter,
      metadataManager: harness.metadataManager,
      operationRepo: harness.operationRepo,
      firestoreAdapter: harness.adapter,
      referenceManager: undefined,
      cacheController: undefined,
      metadataStore: undefined,
      localMetadataManager: undefined,
    }),
  }))
);

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));
const profilePath = (user: string) => `users/${user}/backup/profile`;

describe('C-F1: metadata doc ref memoized across logout(A) -> login(B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig, USER_A);
    seedRemoteProfile(harness.fake, USER_A, {
      alpha: 'A-alpha',
      beta: 'A-beta',
      gamma: 'A-gamma',
    });
    seedRemoteProfile(harness.fake, USER_B, {
      alpha: 'B-alpha',
      beta: 'B-beta',
      gamma: 'B-gamma',
    });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('read side: after user switch, remote metadata for B comes from B\'s backup document', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    await ganon.login(USER_A);
    await ganon.logout({ backup: false });
    await ganon.login(USER_B);

    // Fresh read for the logged-in user B. With the memoized ref this returns A's digest.
    const meta = await harness.metadataManager.getRemoteMetadataOnly('alpha');
    expect(meta?.digest).toBe(computeHash('B-alpha'));

    ganon.destroy();
  });

  it('write side: after user switch, B\'s legacy-map flush lands in B\'s document, not A\'s', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    await ganon.login(USER_A);
    // One legacy-map flush during A's session memoizes A's doc ref inside the flush queue.
    await harness.metadataManager.recordLocalChange('gamma', {
      digest: 'a-local-gamma',
      version: 800,
      syncStatus: SyncStatus.Pending,
    });
    harness.scheduler.advance(1_001); // default metadataFlushDebounceMs = 1000
    await flushMicrotasks();
    expect(
      (harness.fake.getDocument(profilePath(USER_A))![REMOTE_METADATA_KEY] as Record<string, unknown>).gamma
    ).toEqual({ d: 'a-local-gamma', v: 800 });

    await ganon.logout({ backup: false });
    await ganon.login(USER_B);

    await harness.metadataManager.recordLocalChange('beta', {
      digest: 'b-local-digest',
      version: 900,
      syncStatus: SyncStatus.Pending,
    });
    harness.scheduler.advance(1_001);
    await flushMicrotasks();

    const docA = harness.fake.getDocument(profilePath(USER_A))!;
    const docB = harness.fake.getDocument(profilePath(USER_B))!;
    const legacyA = docA[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;
    const legacyB = docB[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;

    // A's document must be untouched by B's session.
    expect(legacyA.beta).toEqual({ d: computeHash('A-beta'), v: 500 });
    // B's document must carry B's flush.
    expect(legacyB.beta).toEqual({ d: 'b-local-digest', v: 900 });

    ganon.destroy();
  });
});
