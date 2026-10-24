/**
 * Finding: A-F1
 * Severity: High (stuck session)
 * Mechanism: `login()` relies on `syncEngine.start()` to fire the hydrate pass that settles the
 *   hydration cycle, but `SyncEngine.start()` is a no-op when `running` is already true (guest
 *   `startSync()` at boot, or login over an already-running session), so the cycle never settles
 *   and `whenHydrated()` hangs; with `earlyWriteGuard: 'throw'` every cloud-key write throws.
 * Targets: src/Ganon.ts:513-518 (start gate) and src/Ganon.ts:133-145 (startSync) vs
 *   src/sync/SyncEngine.ts:97-101 (idempotent start).
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
import SyncError from '../../errors/SyncError';
import {
  SIX_TWO_CLOUD_CONFIG,
  SIX_TWO_USER,
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

let harness = createSixTwoStack({ ...baseConfig });

// The harness builds SyncEngine with the raw config; forward Ganon's internal eventCallbacks
// (onHydrationComplete) to the real engine so whenHydrated() can settle exactly as in production.
jest.mock('../../factory/DependencyFactory', () =>
  jest.fn().mockImplementation((cfg: { eventCallbacks?: unknown }) => ({
    getDependencies: () => ({
      ...(((harness.syncEngine as unknown as { config: { eventCallbacks?: unknown } }).config.eventCallbacks =
        cfg.eventCallbacks), {}),
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

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

describe('A-F1 login() over an already-running engine never settles whenHydrated()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack({ ...baseConfig });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('guest startSync() at boot, then login(present remote): whenHydrated() must settle', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>({ ...baseConfig, earlyWriteGuard: 'throw' });

    // App boot as guest: a network-recovery / boot handler turns sync on (LTG_ADOPTION item 6).
    ganon.startSync();

    const result = await ganon.login(SIX_TWO_USER);
    expect(result.action).toBe('restore');
    expect(result.restoredKeys).toBe(3);

    let settled: string | undefined;
    void ganon.whenHydrated().then(r => {
      settled = r;
    });
    await flush();
    // Give any in-flight hydrate pass plenty of room to complete.
    harness.scheduler.advance(1_000);
    await flush();

    // Restore already completed; a consumer awaiting whenHydrated() must not hang.
    expect(settled).toBe('hydrated');
    // And cloud-key writes must not be blocked indefinitely by the early-write guard.
    expect(() => ganon.set('alpha', 'post-login-edit')).not.toThrow(SyncError);

    ganon.destroy();
  });

  it('control: same login without a prior guest startSync() settles (harness sanity; expected PASS)', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(SIX_TWO_USER);
    let settled: string | undefined;
    void ganon.whenHydrated().then(r => {
      settled = r;
    });
    await flush();
    expect(settled).toBe('hydrated');
    ganon.destroy();
  });
});
