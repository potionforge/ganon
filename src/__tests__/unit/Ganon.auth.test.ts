import { jest } from '@jest/globals';
import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';

// Mocks
jest.mock('../../factory/DependencyFactory', () => {
  return jest.fn().mockImplementation(() => ({
    getDependencies: () => mockDeps
  }));
});

// Types
interface TestStorage extends BaseStorageMapping {
  email: string;
  key1: string;
}

// Shared mocks
const mockStorageManager: any = {
  get: jest.fn(),
  set: jest.fn(),
  remove: jest.fn(),
  contains: jest.fn(),
  clearAllData: jest.fn(),
};

const mockSyncController: any = {
  startSyncInterval: jest.fn(),
  stopSyncInterval: jest.fn(),
  cancelPendingOperations: jest.fn(),
  syncAll: jest.fn(),
  restore: jest.fn(),
  hasAnyRemoteData: jest.fn(),
  probeRemoteData: jest.fn(),
};

const mockFirestoreManager: any = {};
const mockNetworkMonitor: any = { destroy: jest.fn() };
const mockUserManager: any = {
  getCurrentUser: jest.fn(),
  isUserLoggedIn: jest.fn(),
};

const mockDeps = {
  storageManager: mockStorageManager,
  syncController: mockSyncController,
  firestoreManager: mockFirestoreManager,
  networkMonitor: mockNetworkMonitor,
  userManager: mockUserManager,
};

const config: GanonConfig<TestStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    doc: {
      docKeys: ['key1'],
      subcollectionKeys: [],
    },
  },
  autoStartSync: false,
};

describe('Ganon auth lifecycle', () => {
  let ganon: Ganon<TestStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserManager.getCurrentUser.mockReturnValue(undefined);
    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    mockStorageManager.get.mockReturnValue(undefined);
    ganon = new Ganon<TestStorage>(config);
  });

  it('login: noop when same user already set locally (app reopen)', async () => {
    mockUserManager.getCurrentUser.mockReturnValue('u@example.com');
    mockStorageManager.get.mockReturnValue('u@example.com');

    // Recreate ganon to read the mocked current user
    ganon = new Ganon<TestStorage>(config);
    const result = await ganon.login('u@example.com');

    expect(result.action).toBe('noop');
    expect(result.probe).toBe('skipped');
    expect(result.restoredKeys).toBe(0);
    expect(result.restoreFailedKeys).toBe(0);
    expect(mockSyncController.probeRemoteData).not.toHaveBeenCalled();
    expect(mockSyncController.restore).not.toHaveBeenCalled();
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
  });

  it('login: restores when remote data exists for new login', async () => {
    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'present' });
    mockSyncController.restore.mockResolvedValue({
      success: true,
      restoredKeys: ['key1'],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u2@example.com');
    expect(result.action).toBe('restore');
    expect(result.probe).toBe('present');
    expect(result.restoredKeys).toBe(1);
    expect(result.restoreFailedKeys).toBe(0);
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u2@example.com');
    expect(mockSyncController.restore).toHaveBeenCalled();
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
  });

  it('login: surfaces partial restore via restoreFailedKeys on present probe', async () => {
    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'present' });
    mockSyncController.restore.mockResolvedValue({
      success: false,
      restoredKeys: ['key1'],
      failedKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u-partial@example.com');
    expect(result.action).toBe('restore');
    expect(result.probe).toBe('present');
    expect(result.restoredKeys).toBe(1);
    expect(result.restoreFailedKeys).toBe(8);
  });

  it('login: backs up when no remote data exists for new login', async () => {
    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'absent' });
    mockSyncController.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u3@example.com');
    expect(result.action).toBe('backup');
    expect(result.probe).toBe('absent');
    expect(result.restoredKeys).toBe(0);
    expect(result.restoreFailedKeys).toBe(0);
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u3@example.com');
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.restore).not.toHaveBeenCalled();
  });

  it('login: refuses backup and restores when remote probe is indeterminate', async () => {
    mockSyncController.probeRemoteData.mockResolvedValue({
      status: 'indeterminate',
      reason: 'user: permission-denied',
    });
    mockSyncController.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u-indeterminate@example.com');
    expect(result.action).toBe('restore');
    expect(result.probe).toBe('indeterminate');
    expect(result.probeReason).toBe('user: permission-denied');
    expect(result.restoreFailedKeys).toBe(0);
    expect(mockSyncController.restore).toHaveBeenCalled();
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
  });

  // MOCK BOUNDARY: these two tests mock the syncController (probeRemoteData + restore) because
  // they assert Ganon's *login decision* — that indeterminate picks restore over the destructive
  // backup arm, and that a failing restore surfaces rather than falling back. The REAL restore()
  // behavior they lean on (fetch→undefined on an empty remote returns success/0-keys and never
  // writes; a rejecting fetch/hydrate surfaces as failure) is exercised without mocking restore in
  // SyncController.test.ts → "Restore Operations" (see "restore on an empty remote..." and
  // "should handle restore failures gracefully"). That is where fetch-returns-undefined is proven;
  // here we only prove Ganon routes on top of it.
  it('login: indeterminate on a genuinely-empty remote restores nothing but never wipes local or backs up', async () => {
    // Brand-new account, transient probe error that clears by restore time: probe is
    // indeterminate, restore reaches an empty-but-readable remote and pulls nothing back.
    // The guest shell must survive: no destructive backup arm, no local wipe.
    mockSyncController.probeRemoteData.mockResolvedValue({
      status: 'indeterminate',
      reason: 'user: unavailable',
    });
    mockSyncController.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });

    const result = await ganon.login('u-fresh@example.com');

    expect(result.action).toBe('restore');
    expect(mockSyncController.restore).toHaveBeenCalledTimes(1);
    // The contract must surface the exact stranded-guest signal for the app:
    // restore + indeterminate + 0 keys. LoginManager keys its fresh-account
    // backup branch off precisely this triple.
    expect(result.probe).toBe('indeterminate');
    expect(result.restoredKeys).toBe(0);
    expect(result.restoreFailedKeys).toBe(0);
    expect(result.probeReason).toBe('user: unavailable');
    // Indeterminate must never select the destructive backup arm...
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
    // ...and must never wipe the guest's local data.
    expect(mockStorageManager.clearAllData).not.toHaveBeenCalled();
  });

  it('login: indeterminate then failing restore rejects without falling back to destructive backup', async () => {
    // Transient error persists into restore (hydrateMetadata also fails). login must surface
    // the error for the app to handle and must NOT run syncAll as a fallback against a
    // possibly-poisoned shell, nor wipe local data.
    mockSyncController.probeRemoteData.mockResolvedValue({
      status: 'indeterminate',
      reason: 'user: permission-denied',
    });
    mockSyncController.restore.mockRejectedValue(
      new Error('Metadata hydrate failed for backup document(s): user: permission-denied')
    );

    await expect(ganon.login('u-fresh2@example.com')).rejects.toThrow('Metadata hydrate failed');
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
    expect(mockStorageManager.clearAllData).not.toHaveBeenCalled();
  });

  it('login: restarts sync when autoStartSync is enabled and restoring', async () => {
    const configWithAutoSync: GanonConfig<TestStorage> = {
      ...config,
      autoStartSync: true,
    };
    ganon = new Ganon<TestStorage>(configWithAutoSync);
    jest.clearAllMocks();

    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'present' });
    mockSyncController.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u4@example.com');
    expect(result.action).toBe('restore');
    expect(mockSyncController.restore).toHaveBeenCalled();
    expect(mockSyncController.startSyncInterval).toHaveBeenCalled();
  });

  it('login: restarts sync when autoStartSync is enabled and backing up', async () => {
    const configWithAutoSync: GanonConfig<TestStorage> = {
      ...config,
      autoStartSync: true,
    };
    ganon = new Ganon<TestStorage>(configWithAutoSync);
    jest.clearAllMocks();

    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'absent' });
    mockSyncController.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u5@example.com');
    expect(result.action).toBe('backup');
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.startSyncInterval).toHaveBeenCalled();
  });

  it('login: does not restart sync when autoStartSync is disabled', async () => {
    mockSyncController.probeRemoteData.mockResolvedValue({ status: 'absent' });
    mockSyncController.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u6@example.com');
    expect(result.action).toBe('backup');
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.startSyncInterval).not.toHaveBeenCalled();
  });

  it('logout: backs up by default, stops sync, cancels, and clears user', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout();
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.cancelPendingOperations).toHaveBeenCalled();
    expect(mockSyncController.stopSyncInterval).toHaveBeenCalled();
    expect(mockStorageManager.clearAllData).toHaveBeenCalled();
  });

  it('logout: can skip backup when option provided', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout({ backup: false });
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
    expect(mockSyncController.cancelPendingOperations).toHaveBeenCalled();
    expect(mockSyncController.stopSyncInterval).toHaveBeenCalled();
    expect(mockStorageManager.clearAllData).toHaveBeenCalled();
  });
});


