/**
 * beta-7.1 design ratchet (new): login(A) → enqueue set gated at txn → logout({ backup: false })
 * → login(A) after remote moved forward → release gate → remote must not be clobbered; local
 * must remain the restored remote value (not the pre-logout stale outbound edit).
 *
 * Expected to fail until SessionToken + processOperations fence land (same class as F-F1 / E-F1).
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
import { MARK_AS_PENDING_DEBOUNCE_MS } from '../../sync/SyncEngine';
import computeHash from '../../utils/computeHash';
import { REMOTE_METADATA_KEY } from '../../constants';
import {
  SIX_TWO_CLOUD_CONFIG,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

const USER_A = 'user-a-relogin';
const REMOTE_AFTER_OTHER_DEVICE = 'remote-from-other-device';
const STALE_OUTBOUND = 'stale-local-edit-never-should-land';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
};

let harness = createSixTwoStack(baseConfig);

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
    }),
  }))
);

describe('beta7.1 I11: stale in-flight set after same-user re-login must not clobber restore', () => {
  beforeEach(() => {
    harness = createSixTwoStack(baseConfig);
    seedRemoteProfile(harness.fake, USER_A, {
      alpha: 'remote-v1',
      beta: 'b',
      gamma: 'g',
    });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('restore wins over a session-A SetOperation that completes after login(A) again', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(USER_A);
    expect(harness.storage.get('alpha')).toBe('remote-v1');

    harness.storage.set('alpha', STALE_OUTBOUND);
    harness.syncEngine.markAsPending('alpha');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await Promise.resolve();

    let releaseTx!: () => void;
    let txEntered = false;
    const txGate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const realRunTransaction = harness.fake.runTransaction.bind(harness.fake);
    jest.spyOn(harness.fake, 'runTransaction').mockImplementation(async (fn) => {
      if (!txEntered) {
        txEntered = true;
        await txGate;
      }
      return realRunTransaction(fn);
    });

    const syncPendingPromise = harness.syncEngine.syncPending();
    for (let i = 0; i < 50 && !txEntered; i += 1) {
      await Promise.resolve();
    }
    expect(txEntered).toBe(true);

    await ganon.logout({ backup: false });

    const profilePath = `users/${USER_A}/backup/profile`;
    const remoteDigest = computeHash(REMOTE_AFTER_OTHER_DEVICE);
    harness.fake.setDocument(profilePath, {
      alpha: REMOTE_AFTER_OTHER_DEVICE,
      beta: 'b',
      gamma: 'g',
      [REMOTE_METADATA_KEY]: {
        alpha: { d: remoteDigest, v: 2000 },
        beta: { d: computeHash('b'), v: 500 },
        gamma: { d: computeHash('g'), v: 500 },
      },
    });

    await ganon.login(USER_A);
    expect(harness.storage.get('alpha')).toBe(REMOTE_AFTER_OTHER_DEVICE);
    expect(harness.metadataManager.get('alpha')!.digest).toBe(remoteDigest);

    releaseTx();
    await syncPendingPromise;
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
    }

    const profileAfter = harness.fake.getDocument(profilePath);
    expect(profileAfter?.alpha).toBe(REMOTE_AFTER_OTHER_DEVICE);
    expect(harness.storage.get('alpha')).toBe(REMOTE_AFTER_OTHER_DEVICE);
    expect(harness.metadataManager.get('alpha')!.digest).toBe(remoteDigest);

    ganon.destroy();
  });
});
