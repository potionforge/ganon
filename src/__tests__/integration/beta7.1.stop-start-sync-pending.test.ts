/**
 * Queued SetOperation survives stopSync() → startSync() and syncPending() after generation bump.
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
import { SyncStatus } from '../../models/sync/SyncStatus';
import SetOperation from '../../sync/operations/SetOperation';
import {
  SixTwoStorage,
  SIX_TWO_CLOUD_CONFIG,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';

const USER = 'stop-start-user@example.com';

const config: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
};

describe('beta7.1 stop/start pending op', () => {
  it('re-stamps queued set op after stop() and start() then lands the write', async () => {
    const harness = createSixTwoStack(config, USER);
    harness.storage.set('email', USER);
    harness.storage.set('alpha', 'after-stop');
    harness.syncEngine.mintSession(USER);

    const session = harness.syncEngine.captureSessionForOperation();
    harness.operationRepo.addOperation(
      'alpha',
      new SetOperation(
        'alpha',
        harness.storage,
        harness.firestoreManager,
        harness.metadataManager,
        session
      )
    );
    await harness.metadataManager.recordLocalChange('alpha', {
      digest: computeHash('after-stop'),
      version: 2,
      syncStatus: SyncStatus.Pending,
    });

    harness.syncEngine.stop();
    harness.syncEngine.start();
    await harness.operationRepo.processOperations();

    const doc = harness.fake.getDocument(`users/${USER}/backup/profile`);
    expect(doc?.alpha).toBe('after-stop');
    expect(harness.syncEngine.getSyncStatus('alpha')).toBe(SyncStatus.Synced);
  });
});
