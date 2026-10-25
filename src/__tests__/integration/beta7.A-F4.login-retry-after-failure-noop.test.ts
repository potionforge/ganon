/**
 * Finding: A-F4
 * Severity: High (empty authenticated shell / stuck session, #35 class)
 * Mechanism: `login()` writes the identifier (src/Ganon.ts:474) before the probe/restore awaits;
 *   when restore throws, the catch (src/Ganon.ts:522-525) settles waiters 'login-failed' and
 *   rethrows but leaves the identifier in place. The app's retry `login(sameUser)` hits the
 *   same-user noop guard (src/Ganon.ts:463-467) and never restores remote data; `autoStartSync`
 *   never ran `syncEngine.start()` either, so no interval/hydrate pass ever repairs it.
 *   (Documented as a known issue in LTG_ADOPTION.md "Known issue — login() retry noop"; no
 *   library fix or ticket exists at this commit.)
 * Targets: src/Ganon.ts:461-474, :522-525.
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

describe('A-F4 login() retry after a transient remote failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack({ ...baseConfig });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('second login(sameUser) after a failed first attempt must restore remote data', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    // Transient outage: every document read fails during the first login attempt.
    const getSpy = jest
      .spyOn(harness.adapter, 'getDocument')
      .mockRejectedValue(new Error('unavailable'));

    await expect(ganon.login(SIX_TWO_USER)).rejects.toThrow();
    expect(harness.storage.get('email' as keyof SixTwoStorage)).toBeUndefined();
    expect(harness.storage.get('alpha')).toBeUndefined();

    // Network recovers; the app retries the same login.
    getSpy.mockRestore();
    const retry = await ganon.login(SIX_TWO_USER);

    // Observed at 6f05a4c: { action: 'noop', probe: 'skipped' } — nothing is ever restored.
    expect(retry.action).toBe('restore');
    expect(retry.restoredKeys).toBe(3);
    expect(harness.storage.get('alpha')).toBe('remote-alpha');

    ganon.destroy();
  });
});
