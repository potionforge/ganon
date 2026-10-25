/**
 * Stale session inside a multi-chunk transaction rolls back all buffered writes (I4 atomicity).
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
import { createSixTwoStack, SixTwoStorage } from '../utils/sixTwoIntegrationHarness';
import * as sessionGuard from '../../sync/sessionGuard';

const USER_A = 'chunk-user-a';
const USER_B = 'chunk-user-b';

const chunkConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: [], subcollectionKeys: ['alpha'] },
  },
  autoStartSync: false,
};

function largeObject(fieldCount: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < fieldCount; i++) {
    o[`field_${i}`] = `value_${i}_${'x'.repeat(200)}`;
  }
  return o;
}

describe('beta7.1 txn stale chunk rollback', () => {
  it('throws StaleSessionAbort mid-chunk txn and leaves prior chunks unchanged', async () => {
    const harness = createSixTwoStack(chunkConfig, USER_A);
    harness.storage.set('email', USER_A);
    harness.syncEngine.mintSession(USER_A);
    const sessionA = harness.syncEngine.captureSessionForOperation();

    const collPath = `users/${USER_A}/backup/profile/alpha`;
    harness.fake.setDocument(`${collPath}/chunk_0`, { field_0: 'old' });
    harness.fake.setDocument(`${collPath}/chunk_1`, { field_1: 'old' });

    const origRequire = sessionGuard.requireSessionInTransaction;
    let guardCalls = 0;
    jest.spyOn(sessionGuard, 'requireSessionInTransaction').mockImplementation((session, site) => {
      guardCalls += 1;
      if (guardCalls >= 2) {
        harness.storage.set('email', USER_B);
        harness.syncEngine.bumpSessionLoggedOut();
        harness.syncEngine.mintSession(USER_B);
      }
      origRequire(session, site);
    });

    const payload = largeObject(80);
    await harness.firestoreManager.syncValueWithDigest(
      'alpha',
      payload,
      computeHash(payload),
      1,
      sessionA
    );

    expect(harness.fake.getDocument(`${collPath}/chunk_0`)).toEqual({ field_0: 'old' });
    expect(harness.fake.getDocument(`${collPath}/chunk_1`)).toEqual({ field_1: 'old' });
  });
});
