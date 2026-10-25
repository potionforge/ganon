/**
 * beta7.F-F3: after logout({ backup: false }), login(sameUser) must restore, not noop.
 * UserManager.getCurrentUser() must read storage (not a stale ctor-time cache) so the
 * same-user guard does not fire after logout/clearAllData.
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
} from '../utils/sixTwoIntegrationHarness';

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
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

describe('beta7.F-F3 logout then login same user restores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('login → logout({ backup: false }) → login(same user) chooses restore', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);

    try {
      ganon.set('alpha', 'local-alpha');
      ganon.set('beta', 'local-beta');

      const firstLogin = await ganon.login(SIX_TWO_USER);
      expect(firstLogin.action).toBe('backup');

      // Drain metadata flush debounce so remote tenure exists before logout.
      harness.scheduler.advance(1_001);
      await Promise.resolve();

      await ganon.logout({ backup: false });

      const secondLogin = await ganon.login(SIX_TWO_USER);
      expect(secondLogin.action).toBe('restore');
      expect(secondLogin.action).not.toBe('noop');
    } finally {
      ganon.destroy();
    }
  });
});
