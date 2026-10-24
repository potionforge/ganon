/**
 * beta7.B-F4: login(B) while A is logged in runs full logout teardown first;
 * an in-flight hydrate for A must not write into B's session.
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
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
};

let harness = createSixTwoStack(baseConfig);

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

describe('beta7.B-F4 login(B) over A with in-flight hydrate', () => {
  beforeEach(() => {
    harness = createSixTwoStack(baseConfig);
    seedRemoteProfile(harness.fake, 'user-a', { alpha: 'a-alpha', beta: 'a-beta', gamma: 'a-gamma' });
    seedRemoteProfile(harness.fake, 'user-b', { alpha: 'b-alpha', beta: 'b-beta', gamma: 'b-gamma' });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('teardown on user switch prevents A hydrate from landing in B storage', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login('user-a');
    harness.storage.set('alpha', 'tampered-local');

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve;
    });
    const realFetch = harness.firestoreManager.fetch.bind(harness.firestoreManager);
    jest.spyOn(harness.firestoreManager, 'fetch').mockImplementation(async (key) => {
      if (key === 'alpha') {
        await fetchGate;
      }
      return realFetch(key);
    });

    const inFlight = harness.syncEngine.hydrate(['alpha']);
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      if ((harness.firestoreManager.fetch as jest.Mock).mock.calls.some(c => c[0] === 'alpha')) {
        break;
      }
    }

    const loginB = ganon.login('user-b');
    releaseFetch();
    await inFlight;
    await loginB;

    expect(harness.storage.get('alpha')).toBe('b-alpha');
    expect(harness.userManager.getCurrentUser()).toBe('user-b');

    ganon.destroy();
  });
});
