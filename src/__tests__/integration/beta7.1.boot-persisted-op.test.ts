/**
 * Persisted SetOperation survives DependencyFactory-style boot wiring and executes after start().
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { SyncStatus } from '../../models/sync/SyncStatus';
import {
  SixTwoStorage,
  SIX_TWO_CLOUD_CONFIG,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';

const USER = 'offline-user@example.com';
const PENDING_OPERATIONS_KEY = 'ganon_pending_operations';

const config: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
};

describe('beta7.1 boot persisted op', () => {
  it('re-stamps and executes a SetOperation loaded before SyncEngine.configureSession', async () => {
    const operationsKv = new MMKVFaker();
    operationsKv.set(
      PENDING_OPERATIONS_KEY,
      JSON.stringify([
        {
          type: 'set',
          key: 'alpha',
          userId: USER,
          retryCount: 0,
          maxRetries: 3,
        },
      ])
    );

    const harness = createSixTwoStack(config, USER, operationsKv);
    harness.storage.set('email', USER);
    harness.storage.set('alpha', 'offline-alpha');
    await harness.metadataManager.recordLocalChange('alpha', {
      digest: computeHash('offline-alpha'),
      version: 1,
      syncStatus: SyncStatus.Pending,
    });

    expect(operationsKv.getString(PENDING_OPERATIONS_KEY)).toBeDefined();

    harness.syncEngine.start();
    await harness.operationRepo.processOperations();

    const doc = harness.fake.getDocument(`users/${USER}/backup/profile`);
    expect(doc?.alpha).toBe('offline-alpha');
    expect(operationsKv.getString(PENDING_OPERATIONS_KEY)).toBeUndefined();
  });
});
