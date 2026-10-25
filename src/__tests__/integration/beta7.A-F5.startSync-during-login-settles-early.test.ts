/**
 * Finding: A-F5
 * Severity: High (local clobber of a consumer write made after whenHydrated() resolved)
 * Mechanism: `login()` is mid-`await this.restore()` (src/Ganon.ts:482) when a consumer calls
 *   `startSync()` (e.g. network-recovery handler). `startSync()` sees `_syncStopped === false`
 *   (cleared by `_beginHydrationCycle`), skips the re-arm, and calls `syncEngine.start()`, which
 *   fires a concurrent `hydrate()` pass. That pass's `onHydrationComplete` settles the *login*
 *   cycle 'hydrated' (src/Ganon.ts:65-71) while restore is still in flight, so `whenHydrated()`
 *   resolves and `earlyWriteGuard` lifts; a consumer write made at that point is then
 *   blind-overwritten by the still-running restore (`SyncEngine.restore` writes every remote value).
 * Targets: src/Ganon.ts:133-145 (startSync), :65-71 (onHydrationComplete settle), :482.
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

describe('A-F5 startSync() interleaved with login() restore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack({ ...baseConfig });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('whenHydrated() must stay pending until the login restore has written its values', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    // Hold restore open so we can interleave.
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>(resolve => {
      releaseRestore = resolve;
    });
    const realRestore = harness.syncEngine.restore.bind(harness.syncEngine);
    jest.spyOn(harness.syncEngine, 'restore').mockImplementation(async () => {
      await restoreGate;
      return realRestore();
    });

    const loginPromise = ganon.login(SIX_TWO_USER);
    await flush();

    // Consumer pattern mandated by §4.6 / LTG_ADOPTION: gate cloud-key writes on whenHydrated().
    let settledAt: 'before-restore' | 'after-restore' | undefined;
    let restoreReleased = false;
    const gatedWrite = ganon.whenHydrated().then(reason => {
      settledAt = restoreReleased ? 'after-restore' : 'before-restore';
      ganon.set('alpha', 'post-hydration-edit');
      return reason;
    });

    // Network-recovery handler (LTG_ADOPTION item 6) turns sync on while login is still restoring.
    ganon.startSync();
    await flush(50);

    restoreReleased = true;
    releaseRestore();
    await loginPromise;
    await gatedWrite;
    await flush();

    // Observed at 6f05a4c: the concurrent hydrate pass settled the login cycle 'hydrated' while
    // restore was still gated; the consumer's gated write ran, then restore blind-overwrote it.
    expect(settledAt).toBe('after-restore');
    expect(harness.storage.get('alpha')).toBe('post-hydration-edit');

    ganon.destroy();
  });
});
