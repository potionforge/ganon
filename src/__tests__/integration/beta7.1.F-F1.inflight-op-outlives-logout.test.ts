/**
 * Finding: F-F1
 * Severity: High (wrong-account write + poisoned digest surviving logout)
 * Mechanism: OperationRepo.processOperations() iterates a snapshot and has no drain/abort
 *   primitive, so an operation whose `await operation.execute()` is in flight when
 *   SyncEngine.cancelPendingOperations() -> operationRepo.clearAll() runs keeps executing;
 *   SetOperation resolves the backup ref via userManager.getCurrentUser() *inside* the
 *   transaction (after the await), so once login(B) sets the identifier, session A's value is
 *   written into users/B/backup/profile and A's digest is recorded into B's MetadataStore.
 * Targets: src/sync/OperationRepo.ts:166 (snapshot), :189 (await execute, no post-await
 *   cancellation check), :139-143 (clearAll does not abort in-flight work);
 *   src/sync/SyncEngine.ts:1054-1081 (cancelPendingOperations drains only lastBackup).
 *
 * Real stack: createSixTwoStack (FakeFirestore, FakeScheduler, FakeClock, MMKVFaker). The only
 * instrumentation is a gate on FakeFirestore.runTransaction that holds the first transaction.
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
import {
  SIX_TWO_CLOUD_CONFIG,
  SIX_TWO_USER,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

let harness = createSixTwoStack({
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
});

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

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
};

const USER_A = SIX_TWO_USER;
const USER_B = 'user-b-next-account';
const A_EDIT = 'A-local-edit-made-before-logout';

async function flushMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

describe('F-F1: in-flight SetOperation outlives logout/clearAllData and lands under the next account', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
    jest.spyOn(harness.adapter, 'setDocument');
    jest.spyOn(harness.adapter, 'setDocumentWithTransaction');
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it("session A's queued set executes after cancelPendingOperations + clearAllData and writes into user B's backup doc", async () => {
    seedRemoteProfile(harness.fake, USER_A, { alpha: 'a', beta: 'b', gamma: 'g' });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(USER_A);

    // Local edit under A -> SetOperation enqueued (debounced mark flushed).
    harness.storage.set('alpha', A_EDIT);
    harness.syncEngine.markAsPending('alpha');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await Promise.resolve();
    expect(harness.syncEngine.hasPendingOperations()).toBe(true);

    // Hold the FIRST Firestore transaction (A's SetOperation) at the await boundary inside
    // SetOperation.execute -> FirestoreManager.syncValueWithDigest -> runTransaction.
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

    // Logout A while the operation is in flight. cancelPendingOperations() clears the queue
    // map but does not drain/abort the running processOperations() loop.
    await ganon.logout({ backup: false });
    expect(harness.storage.get('email')).toBeUndefined();
    expect(harness.metadataManager.get('alpha')!.digest).toBe('');

    // Next account logs in (remote absent -> backup arm; local is empty so nothing is marked).
    await ganon.login(USER_B);
    expect(harness.userManager.getCurrentUser()).toBe(USER_B);
    const bProfileBefore = harness.fake.getDocument(`users/${USER_B}/backup/profile`);
    expect(bProfileBefore?.alpha).toBeUndefined();

    // Release A's transaction: the write resolves its backup ref from getCurrentUser() == B.
    releaseTx();
    await syncPendingPromise;
    await flushMicrotasks();

    const bProfileAfter = harness.fake.getDocument(`users/${USER_B}/backup/profile`);

    // EXPECTED (I11): nothing scheduled under A may land under B, and B's metadata store must
    // not carry A's digest. ACTUAL at 6f05a4c: alpha === A_EDIT in users/B/backup/profile and
    // metadataManager.get('alpha').digest === computeHash(A_EDIT).
    expect(bProfileAfter?.alpha).toBeUndefined();
    expect(harness.metadataManager.get('alpha')!.digest).not.toBe(computeHash(A_EDIT));

    ganon.destroy();
  });
});
