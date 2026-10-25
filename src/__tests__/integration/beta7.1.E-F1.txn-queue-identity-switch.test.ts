/**
 * Finding: E-F1
 * Severity: High (wrong-account write, I11)
 * Mechanism: `syncValueWithDigest` captures value/digest/version at call time but the queued
 *   transaction callback resolves the user identity (`getRefForKey` → `getCurrentUser()`) only
 *   when the FirestoreManager transaction queue reaches it; an identity switch between enqueue
 *   and execution writes user A's value + digest into user B's backup document.
 * Targets: src/firestore/FirestoreManager.ts:102-106 (queue), :225-227 (callback),
 *   :249, :280 (login check + ref resolution at execution time, no ownerAtSchedule guard —
 *   contrast with backupLastBackupToUserDocument :856-867).
 *
 * Real stack: FirestoreManager + FirestoreAdapter + FirestoreReferenceManager over FakeFirestore
 * (createSixTwoStack). No jest mocks on the code under test.
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
import {
  SixTwoStorage,
  createSixTwoStack,
} from '../utils/sixTwoIntegrationHarness';

const CLOUD_CONFIG: GanonConfig<SixTwoStorage>['cloudConfig'] = {
  profile: { docKeys: ['alpha', 'beta'], subcollectionKeys: [] },
};

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
};

const USER_A = 'user-A';
const USER_B = 'user-B';

describe('E-F1: queued transaction resolves identity at execution time', () => {
  it('a syncValueWithDigest queued under user A must never land under user B', async () => {
    const harness = createSixTwoStack(baseConfig, USER_A);
    harness.storage.set('email', USER_A);
    harness.syncEngine.mintSession(USER_A);
    const sessionA = harness.syncEngine.captureSessionForOperation();

    // Two SetOperations in the same OperationRepo batch each call syncValueWithDigest;
    // the second is queued behind the first (MAX_CONCURRENT_TRANSACTIONS = 1).
    const p1 = harness.firestoreManager.syncValueWithDigest(
      'alpha',
      'A-alpha',
      computeHash('A-alpha'),
      1,
      sessionA
    );
    const p2 = harness.firestoreManager.syncValueWithDigest(
      'beta',
      'A-beta',
      computeHash('A-beta'),
      1,
      sessionA
    );

    // logout(A) + login(B) completes while the first transaction is still in flight.
    // (Ganon.logout → cancelPendingOperations does not drain in-flight SetOperations or the
    // FirestoreManager transaction queue; Ganon.login(B) sets the identifier.)
    harness.storage.set('email', USER_B);

    await Promise.allSettled([p1, p2]);

    const bDoc = harness.fake.getDocument(`users/${USER_B}/backup/profile`);
    // Expected: nothing of A's data under B (write either lands under A or is refused).
    expect(bDoc).toBeUndefined();
  });
});
