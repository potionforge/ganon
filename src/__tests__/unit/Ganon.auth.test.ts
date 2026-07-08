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

const mockSyncEngine: any = {
  start: jest.fn(),
  startSyncInterval: jest.fn(),
  stopSyncInterval: jest.fn(),
  cancelPendingOperations: jest.fn(),
  syncAll: jest.fn(),
  restore: jest.fn(),
  hasAnyRemoteData: jest.fn(),
  isHydrationInProgress: jest.fn().mockReturnValue(false),
};
mockSyncEngine.start.mockImplementation(() => {
  mockSyncEngine.startSyncInterval();
});

const mockFirestoreManager: any = {};
const mockNetworkMonitor: any = { destroy: jest.fn() };
const mockUserManager: any = {
  getCurrentUser: jest.fn(),
  isUserLoggedIn: jest.fn(),
};

const mockDeps = {
  storageManager: mockStorageManager,
  syncEngine: mockSyncEngine,
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

    expect(result).toBe('noop');
    expect(mockSyncEngine.restore).not.toHaveBeenCalled();
    expect(mockSyncEngine.syncAll).not.toHaveBeenCalled();
  });

  it('login: restores when remote data exists for new login', async () => {
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u2@example.com');
    expect(result).toBe('restore');
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u2@example.com');
    expect(mockSyncEngine.restore).toHaveBeenCalled();
    expect(mockSyncEngine.syncAll).not.toHaveBeenCalled();
  });

  it('login: backs up when no remote data exists for new login', async () => {
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(false);
    mockSyncEngine.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u3@example.com');
    expect(result).toBe('backup');
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u3@example.com');
    expect(mockSyncEngine.syncAll).toHaveBeenCalled();
    expect(mockSyncEngine.restore).not.toHaveBeenCalled();
  });

  it('login: restarts sync when autoStartSync is enabled and restoring', async () => {
    const configWithAutoSync: GanonConfig<TestStorage> = {
      ...config,
      autoStartSync: true,
    };
    ganon = new Ganon<TestStorage>(configWithAutoSync);
    jest.clearAllMocks();

    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u4@example.com');
    expect(result).toBe('restore');
    expect(mockSyncEngine.restore).toHaveBeenCalled();
    expect(mockSyncEngine.start).toHaveBeenCalled();
  });

  it('login: restarts sync when autoStartSync is enabled and backing up', async () => {
    const configWithAutoSync: GanonConfig<TestStorage> = {
      ...config,
      autoStartSync: true,
    };
    ganon = new Ganon<TestStorage>(configWithAutoSync);
    jest.clearAllMocks();

    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(false);
    mockSyncEngine.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u5@example.com');
    expect(result).toBe('backup');
    expect(mockSyncEngine.syncAll).toHaveBeenCalled();
    expect(mockSyncEngine.start).toHaveBeenCalled();
  });

  it('login: does not restart sync when autoStartSync is disabled', async () => {
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(false);
    mockSyncEngine.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u6@example.com');
    expect(result).toBe('backup');
    expect(mockSyncEngine.syncAll).toHaveBeenCalled();
    expect(mockSyncEngine.start).not.toHaveBeenCalled();
  });

  it('logout: backs up by default, stops sync, cancels, and clears user', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout();
    expect(mockSyncEngine.syncAll).toHaveBeenCalled();
    expect(mockSyncEngine.cancelPendingOperations).toHaveBeenCalled();
    expect(mockSyncEngine.stopSyncInterval).toHaveBeenCalled();
    expect(mockStorageManager.clearAllData).toHaveBeenCalled();
  });

  it('logout: can skip backup when option provided', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout({ backup: false });
    expect(mockSyncEngine.syncAll).not.toHaveBeenCalled();
    expect(mockSyncEngine.cancelPendingOperations).toHaveBeenCalled();
    expect(mockSyncEngine.stopSyncInterval).toHaveBeenCalled();
    expect(mockStorageManager.clearAllData).toHaveBeenCalled();
  });
});


