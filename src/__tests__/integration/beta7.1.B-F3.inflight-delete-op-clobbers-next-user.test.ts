/**
 * Finding: B-F3
 * Severity: High (data loss for the next account: local value removed + digest tombstoned)
 * Mechanism: `DeleteOperation.execute` performs `storage.remove(key)` and
 *   `metadataManager.set(key, {digest:'', version: Date.now()})` after `await firestore.delete`
 *   with no session/identity guard, and `cancelPendingOperations()` does not fence the in-flight
 *   `processOperations()` batch. A delete that is mid-flight at logout resumes after `login(B)`
 *   restored B's value for that key, removes B's local value, and writes a tombstone whose
 *   `version = Date.now()` exceeds any remote version so `needsHydration` never re-pulls it.
 * Targets: src/sync/operations/DeleteOperation.ts:28-36 (unguarded post-await local writes),
 *   src/sync/SyncEngine.ts:1054-1087 (cancelPendingOperations does not drain the op batch).
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
import { MARK_AS_PENDING_DEBOUNCE_MS } from '../../sync/SyncEngine';
import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import {
  SIX_TWO_CLOUD_CONFIG,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: true,
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
      referenceManager: undefined,
      cacheController: undefined,
      metadataStore: undefined,
      localMetadataManager: undefined,
    }),
  }))
);

async function flushMicrotasks(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe('B-F3: in-flight DeleteOperation completes after logout and removes the next user\'s value', () => {
  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it("A's pending delete of alpha wipes B's restored alpha and tombstones B's digest", async () => {
    harness = createSixTwoStack(baseConfig);
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    await ganon.login('user-a');
    await flushMicrotasks();
    ganon.set('alpha', 'a-alpha');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await harness.syncEngine.syncPending(); // alpha now in A's backup doc with a digest
    await flushMicrotasks();
    expect(harness.fake.getDocument('users/user-a/backup/profile')?.alpha).toBe('a-alpha');

    ganon.remove('alpha'); // DeleteOperation queued (digest present)
    expect(harness.syncEngine.hasPendingOperations()).toBe(true);

    // Park the remote delete write.
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const realSet = harness.adapter.setDocument.bind(harness.adapter);
    const setSpy = jest
      .spyOn(harness.adapter, 'setDocument')
      .mockImplementationOnce(async (ref, data, options) => {
        await deleteGate;
        return realSet(ref, data, options);
      });

    const syncTick = harness.syncEngine.syncPending();
    await flushMicrotasks();
    expect(setSpy).toHaveBeenCalledTimes(1);

    await ganon.logout();

    seedRemoteProfile(harness.fake, 'user-b', { alpha: 'b-alpha', beta: 'b-beta', gamma: 'b-gamma' });
    await ganon.login('user-b');
    await flushMicrotasks();
    expect(harness.storage.get('alpha')).toBe('b-alpha');
    expect(harness.metadataManager.get('alpha')!.digest).toBe(computeHash('b-alpha'));

    // Network returns: A's delete resumes inside B's session.
    releaseDelete();
    await syncTick;
    await flushMicrotasks();

    expect(harness.storage.get('alpha')).toBe('b-alpha');
    expect(harness.metadataManager.get('alpha')!.digest).toBe(computeHash('b-alpha'));

    ganon.destroy();
  });
});
