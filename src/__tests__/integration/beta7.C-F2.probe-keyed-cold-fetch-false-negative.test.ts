/**
 * beta7.C-F2: cold keyed fetch must not warm an empty partial cache (false-negative probe).
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
import computeHash from '../../utils/computeHash';
import { DIGEST_MAP_KEY, REMOTE_METADATA_KEY } from '../../constants';
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

/** Account with tenure on `beta`/`gamma` only — the first configured key (`alpha`) was never written. */
function seedAccountWithoutFirstKey(): void {
  const meta = {
    beta: { d: computeHash('remote-beta'), v: 500 },
    gamma: { d: computeHash('remote-gamma'), v: 500 },
  };
  harness.fake.setDocument(harness.profileBackupPath, {
    beta: 'remote-beta',
    gamma: 'remote-gamma',
    [REMOTE_METADATA_KEY]: meta,
    [DIGEST_MAP_KEY]: meta,
  });
}

describe('beta7.C-F2 probe after cold metadata fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
    seedAccountWithoutFirstKey();
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('probeRemoteData reports present when a later-configured key has remote tenure', async () => {
    harness.storage.set('email', SIX_TWO_USER);

    const probe = await harness.syncEngine.probeRemoteData();

    expect(probe.status).toBe('present');
  });

  it('login() restores (does not back up guest state over) an account whose first key is absent remotely', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    harness.storage.set('beta', 'guest-beta');

    const result = await ganon.login(SIX_TWO_USER);

    expect(result.probe).toBe('present');
    expect(result.action).toBe('restore');
    expect(harness.storage.get('beta')).toBe('remote-beta');
    expect(harness.fake.getDocument(harness.profileBackupPath)!.beta).toBe('remote-beta');

    ganon.destroy();
  });
});
