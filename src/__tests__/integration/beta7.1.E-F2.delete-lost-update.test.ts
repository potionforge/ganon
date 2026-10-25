/**
 * Finding: E-F2
 * docKey delete must not read-modify-write the whole backup document.
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
import { DIGEST_MAP_KEY } from '../../constants';
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

const USER = 'user-delete-race';

describe('E-F2: delete() must not clobber a concurrent write', () => {
  it('a value + digest written between delete() read and write-back survives', async () => {
    const harness = createSixTwoStack(baseConfig, USER);
    harness.storage.set('email', USER);
    harness.syncEngine.mintSession(USER);
    const session = harness.syncEngine.captureSessionForOperation();
    const path = `users/${USER}/backup/profile`;

    await harness.firestoreManager.syncValueWithDigest(
      'alpha',
      'alpha-v1',
      computeHash('alpha-v1'),
      1,
      session
    );
    await harness.firestoreManager.syncValueWithDigest(
      'beta',
      'beta-old',
      computeHash('beta-old'),
      1,
      session
    );

    const concurrentBeta = { d: computeHash('beta-new'), v: 2 };
    const originalSet = harness.adapter.setDocument.bind(harness.adapter);
    jest.spyOn(harness.adapter, 'setDocument').mockImplementationOnce(async (ref, data, opts) => {
      const current = harness.fake.getDocument(path)!;
      harness.fake.setDocument(path, {
        ...current,
        beta: 'beta-new',
        [DIGEST_MAP_KEY]: {
          ...(current[DIGEST_MAP_KEY] as Record<string, unknown>),
          beta: concurrentBeta,
        },
      });
      return originalSet(ref, data, opts);
    });

    const tombstoneVersion = 42;
    await harness.firestoreManager.delete('alpha', session, { version: tombstoneVersion });

    const doc = harness.fake.getDocument(path)!;
    expect(doc.alpha).toBeUndefined();
    expect(doc.beta).toBe('beta-new');
    expect((doc[DIGEST_MAP_KEY] as Record<string, unknown>).beta).toEqual(concurrentBeta);
    expect((doc[DIGEST_MAP_KEY] as Record<string, unknown>).alpha).toEqual({
      d: '',
      v: tombstoneVersion,
    });
  });
});
