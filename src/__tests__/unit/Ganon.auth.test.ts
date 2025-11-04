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

    expect(result).toBe('noop');
    expect(mockSyncController.restore).not.toHaveBeenCalled();
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
  });

  it('login: restores when remote data exists for new login', async () => {
    mockSyncController.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncController.restore.mockResolvedValue({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
      timestamp: new Date(),
    });
    const result = await ganon.login('u2@example.com');
    expect(result).toBe('restore');
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u2@example.com');
    expect(mockSyncController.restore).toHaveBeenCalled();
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
  });

  it('login: backs up when no remote data exists for new login', async () => {
    mockSyncController.hasAnyRemoteData.mockResolvedValue(false);
    mockSyncController.syncAll.mockResolvedValue({ success: true });
    const result = await ganon.login('u3@example.com');
    expect(result).toBe('backup');
    expect(mockStorageManager.set).toHaveBeenCalledWith('email', 'u3@example.com');
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.restore).not.toHaveBeenCalled();
  });

  it('logout: backs up by default, stops sync, cancels, and clears user', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout();
    expect(mockSyncController.syncAll).toHaveBeenCalled();
    expect(mockSyncController.cancelPendingOperations).toHaveBeenCalled();
    expect(mockSyncController.stopSyncInterval).toHaveBeenCalled();
    expect(mockStorageManager.remove).toHaveBeenCalledWith('email');
  });

  it('logout: can skip backup when option provided', async () => {
    mockUserManager.isUserLoggedIn.mockReturnValue(true);
    await ganon.logout({ backup: false });
    expect(mockSyncController.syncAll).not.toHaveBeenCalled();
    expect(mockSyncController.cancelPendingOperations).toHaveBeenCalled();
    expect(mockStorageManager.remove).toHaveBeenCalledWith('email');
  });
});


