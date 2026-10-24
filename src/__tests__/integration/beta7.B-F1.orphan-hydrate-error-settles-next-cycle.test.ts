/**
 * Finding: B-F1
 * Severity: High (false 'hydrated' signal for the next login cycle defeats the I1 write gate)
 * Mechanism: `_beginHydrationPass`'s catch path calls `onHydrationComplete(_emptyRestoreResult)`
 *   with no generation guard (the success path has one at :178-181), so a hydrate pass orphaned
 *   by `stop()` that later rejects (e.g. metadata-doc read fails after logout) fires the callback
 *   into whatever login cycle is current; `_emptyRestoreResult` is not `aborted`, so
 *   `Ganon.onHydrationComplete` settles the *new* user's `whenHydrated()` waiters as 'hydrated'
 *   while the new user's own pass is still in flight.
 * Targets: src/sync/SyncEngine.ts:190-193 (unguarded callback in catch), vs :178-181 (guarded success path).
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
import { GanonConfig, InternalGanonConfig } from '../../models/config/GanonConfig';
import { RestoreResult } from '../../models/sync/RestoreResult';
import {
  SIX_TWO_CLOUD_CONFIG,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../../__tests__/utils/sixTwoIntegrationHarness';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: true,
  syncInterval: 60_000,
};

// Ganon's internal config (carrying its onHydrationComplete callback) is captured from the
// DependencyFactory constructor and forwarded by the harness engine, so Ganon.whenHydrated()
// is driven by the real SyncEngine exactly as in production.
let mockCapturedInternalConfig: InternalGanonConfig<SixTwoStorage> | undefined;
const forwardingCallbacks: InternalGanonConfig<SixTwoStorage>['eventCallbacks'] = {
  onHydrationComplete: (result) =>
    mockCapturedInternalConfig?.eventCallbacks?.onHydrationComplete?.(result),
};

let harness = createSixTwoStack({ ...baseConfig, eventCallbacks: forwardingCallbacks });

jest.mock('../../factory/DependencyFactory', () =>
  jest.fn().mockImplementation((config: unknown) => {
    mockCapturedInternalConfig = config as InternalGanonConfig<SixTwoStorage>;
    return {
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
    };
  })
);

async function flushMicrotasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe('B-F1: orphaned hydrate pass error path fires onHydrationComplete without a generation guard', () => {
  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('engine: a pass orphaned by stop() that later rejects must not invoke onHydrationComplete', async () => {
    const onHydrationComplete = jest.fn<void, [RestoreResult]>();
    harness = createSixTwoStack({
      ...baseConfig,
      autoStartSync: false,
      eventCallbacks: { onHydrationComplete },
    });
    seedRemoteProfile(harness.fake, 'user-a', { alpha: 'a', beta: 'b', gamma: 'c' });
    harness.storage.set('email', 'user-a');
    await harness.syncEngine.restore();

    let rejectMetaRead!: (e: Error) => void;
    const gate = new Promise<never>((_, reject) => {
      rejectMetaRead = reject;
    });
    // The first getDocument after this is the hydrate pass's pass-start metadata refresh.
    jest.spyOn(harness.adapter, 'getDocument').mockImplementationOnce(() => gate);

    const orphan = harness.syncEngine.hydrate();
    harness.syncEngine.stop(); // generation bump; hydrationPromise released

    rejectMetaRead(new Error('permission-denied'));
    await expect(orphan).rejects.toThrow(/Metadata hydrate failed/);

    // Success path is generation-guarded (:178-181); the error path must be too.
    expect(onHydrationComplete).not.toHaveBeenCalled();
  });

  it('Ganon: user A orphan pass rejecting during user B login resolves B\'s whenHydrated() as "hydrated" early', async () => {
    harness = createSixTwoStack({ ...baseConfig, eventCallbacks: forwardingCallbacks });
    seedRemoteProfile(harness.fake, 'user-a', { alpha: 'a', beta: 'b', gamma: 'c' });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    type Gate = { resolve: (v: unknown) => void; reject: (e: Error) => void; ref: unknown };
    const gates: Gate[] = [];
    let gateNext = false;
    const realGet = harness.adapter.getDocument.bind(harness.adapter);
    jest.spyOn(harness.adapter, 'getDocument').mockImplementation((ref) => {
      if (gateNext) {
        gateNext = false;
        return new Promise((resolve, reject) => gates.push({ resolve, reject, ref }));
      }
      return realGet(ref);
    });
    // Park the pass-start metadata read of every hydrate pass started by start().
    const realStart = harness.syncEngine.start.bind(harness.syncEngine);
    jest.spyOn(harness.syncEngine, 'start').mockImplementation(() => {
      gateNext = true;
      realStart();
    });

    await ganon.login('user-a');
    expect(gates).toHaveLength(1); // A's hydrate pass is parked on its metadata read

    await ganon.logout({ backup: false }); // stop() bumps generation; A's pass is now an orphan
    await ganon.login('user-b');
    expect(gates).toHaveLength(2); // B's hydrate pass is parked too

    let settledWith: string | null = null;
    const waiter = ganon.whenHydrated().then((r) => {
      settledWith = r;
      return r;
    });
    await flushMicrotasks();
    expect(settledWith).toBeNull(); // B's pass is still in flight

    // A's orphan fails now (e.g. rules deny A's doc after logout).
    gates[0].reject(new Error('permission-denied'));
    await flushMicrotasks();

    // B's cycle must still be pending — only B's own pass may settle it.
    expect(settledWith).toBeNull();

    // cleanup: let B's pass finish
    gates[1].resolve(await realGet(gates[1].ref as never));
    await waiter;
    ganon.destroy();
  });
});
