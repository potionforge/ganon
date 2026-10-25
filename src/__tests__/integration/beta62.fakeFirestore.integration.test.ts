/**
 * 6.2 behavior on v2 paths: real SyncEngine + MetadataManager + FakeFirestore (no mocked
 * recordSyncedState / getRemoteMetaForKey / backupLastBackupToUserDocument).
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreManager from '../../firestore/FirestoreManager';
import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import {
  SIX_TWO_CLOUD_CONFIG,
  SIX_TWO_USER,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
  countProfileBackupWrites,
} from '../utils/sixTwoIntegrationHarness';
import { MARK_AS_PENDING_DEBOUNCE_MS } from '../../sync/SyncEngine';

let harness = createSixTwoStack({
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
});

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

const baseConfig: GanonConfig<SixTwoStorage> = {
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: false,
  syncInterval: 60_000,
};

describe('beta-6.2 FakeFirestore integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
    jest.spyOn(harness.adapter, 'setDocument');
    jest.spyOn(harness.adapter, 'setDocumentWithTransaction');
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('login restore seeds digests: syncAll skips untouched keys; one local mutation → one backup write', async () => {
    const remote = {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    } as const;
    seedRemoteProfile(harness.fake, SIX_TWO_USER, remote);

    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    const login = await ganon.login(SIX_TWO_USER);
    expect(login.action).toBe('restore');
    expect(login.probe).toBe('present');
    expect(login.restoredKeys).toBe(3);

    expect(harness.storage.get('alpha')).toBe(remote.alpha);
    expect(harness.metadataManager.get('alpha')?.digest).toBe(computeHash(remote.alpha));

    (harness.adapter.setDocument as jest.Mock).mockClear();

    const backup = await ganon.backup();
    expect(backup.backedUpKeys).toHaveLength(0);
    expect(backup.skippedKeys.sort()).toEqual(['alpha', 'beta', 'gamma'].sort());
    expect(harness.syncEngine.hasPendingOperations()).toBe(false);
    expect(countProfileBackupWrites(harness.adapter, harness.profileBackupPath)).toBe(0);

    harness.storage.set('beta', 'remote-beta-edited');
    (harness.adapter.setDocument as jest.Mock).mockClear();

    const backupOne = await ganon.backup();
    expect(backupOne.backedUpKeys).toEqual(['beta']);
    expect(countProfileBackupWrites(harness.adapter, harness.profileBackupPath)).toBe(1);

    const profileDoc = harness.fake.getDocument(harness.profileBackupPath)!;
    expect(profileDoc.beta).toBe('remote-beta-edited');
    expect(profileDoc.alpha).toBe(remote.alpha);
    expect(profileDoc.gamma).toBe(remote.gamma);

    ganon.destroy();
  });

  it('cancelPendingOperations drains in-flight lastBackup user-doc write before clearAllData', async () => {
    const remote = { alpha: 'a', beta: 'b', gamma: 'g' } as const;
    seedRemoteProfile(harness.fake, SIX_TWO_USER, remote);

    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(SIX_TWO_USER);

    let releaseUserDocWrite!: () => void;
    let userDocWriteEntered = false;
    const userDocGate = new Promise<void>((resolve) => {
      releaseUserDocWrite = resolve;
    });
    const setSpy = jest.spyOn(harness.adapter, 'setDocument');
    const originalSetDocument = FirestoreAdapter.prototype.setDocument;
    setSpy.mockImplementation(async function (this: FirestoreAdapter<SixTwoStorage>, ref, data, opts) {
      if (ref.path === harness.userDocPath && data && 'lastBackup' in (data as object)) {
        userDocWriteEntered = true;
        await userDocGate;
      }
      return originalSetDocument.call(this, ref, data, opts);
    });

    harness.storage.set('alpha', 'changed-for-sync');
    harness.syncEngine.markAsPending('alpha');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await Promise.resolve();
    expect(harness.syncEngine.hasPendingOperations()).toBe(true);

    const syncPendingPromise = harness.syncEngine.syncPending();
    for (let i = 0; i < 50 && !userDocWriteEntered; i += 1) {
      await Promise.resolve();
    }
    expect(userDocWriteEntered).toBe(true);

    const cancelPromise = harness.syncEngine.cancelPendingOperations();
    let cancelSettled = false;
    void cancelPromise.then(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    expect(harness.fake.getDocument(harness.userDocPath)?.lastBackup).toBeUndefined();

    releaseUserDocWrite();
    await cancelPromise;
    expect(cancelSettled).toBe(true);

    const lastBackupBeforeClear = harness.fake.getDocument(harness.userDocPath)?.lastBackup;
    expect(typeof lastBackupBeforeClear).toBe('number');

    const setCallsBeforeClear = setSpy.mock.calls.length;
    ganon.clearAllData();
    expect(harness.storage.get('email')).toBeUndefined();

    await syncPendingPromise.catch(() => undefined);
    await Promise.resolve();

    expect(harness.fake.getDocument(harness.userDocPath)?.lastBackup).toBe(lastBackupBeforeClear);
    expect(setSpy.mock.calls.length).toBe(setCallsBeforeClear);

    ganon.destroy();
  });

  it('in-flight lastBackup for A is skipped when email switches to B before user-doc write starts', async () => {
    const OTHER_USER = 'other-user';
    const remote = { alpha: 'a', beta: 'b', gamma: 'g' } as const;
    seedRemoteProfile(harness.fake, SIX_TWO_USER, remote);

    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    await ganon.login(SIX_TWO_USER);

    let releaseLastBackupWrite!: () => void;
    let lastBackupWriteEntered = false;
    const lastBackupGate = new Promise<void>((resolve) => {
      releaseLastBackupWrite = resolve;
    });
    const userDocPaths = new Set([`users/${SIX_TWO_USER}`, `users/${OTHER_USER}`]);
    const isUserDocLastBackupWrite = (ref: { path: string }, data: unknown) =>
      userDocPaths.has(ref.path) && data !== null && typeof data === 'object' && 'lastBackup' in data;

    const setSpy = jest.spyOn(harness.adapter, 'setDocument');
    const backupSpy = jest.spyOn(harness.firestoreManager, 'backupLastBackupToUserDocument');
    const originalBackupLastBackup = FirestoreManager.prototype.backupLastBackupToUserDocument;
    backupSpy.mockImplementation(async function (
      this: FirestoreManager<SixTwoStorage>,
      timestamp,
      options
    ) {
      lastBackupWriteEntered = true;
      await lastBackupGate;
      return originalBackupLastBackup.call(this, timestamp, options);
    });

    harness.storage.set('alpha', 'changed-for-sync');
    harness.syncEngine.markAsPending('alpha');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await Promise.resolve();

    const syncPendingPromise = harness.syncEngine.syncPending();
    for (let i = 0; i < 50 && !lastBackupWriteEntered; i += 1) {
      await Promise.resolve();
    }
    expect(lastBackupWriteEntered).toBe(true);

    harness.storage.set('email', OTHER_USER as never);

    releaseLastBackupWrite();
    await syncPendingPromise;

    expect(harness.fake.getDocument(`users/${SIX_TWO_USER}`)?.lastBackup).toBeUndefined();
    expect(harness.fake.getDocument(`users/${OTHER_USER}`)?.lastBackup).toBeUndefined();

    const userDocLastBackupSetDocumentCalls = setSpy.mock.calls.filter((call) =>
      isUserDocLastBackupWrite(call[0] as { path: string }, call[1])
    );
    expect(userDocLastBackupSetDocumentCalls).toHaveLength(0);

    ganon.destroy();
  });
});
