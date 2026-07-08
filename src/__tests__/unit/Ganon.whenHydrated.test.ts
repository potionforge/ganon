import { jest } from '@jest/globals';
import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import SyncError from '../../errors/SyncError';

let capturedInternalConfig: { eventCallbacks?: { onHydrationComplete?: (r: any) => void } } | undefined;

jest.mock('../../factory/DependencyFactory', () => {
  return jest.fn().mockImplementation((cfg: any) => {
    capturedInternalConfig = cfg;
    return { getDependencies: () => mockDeps };
  });
});

interface TestStorage extends BaseStorageMapping {
  email: string;
  settings: { theme: string };
}

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
  syncAll: jest.fn().mockResolvedValue({
    success: true,
    backedUpKeys: [],
    failedKeys: [],
    skippedKeys: [],
    timestamp: new Date(),
  }),
  restore: jest.fn().mockResolvedValue({
    success: true,
    restoredKeys: ['settings'],
    failedKeys: [],
    integrityFailures: [],
  }),
  hasAnyRemoteData: jest.fn(),
};

const mockUserManager: any = {
  getCurrentUser: jest.fn(),
  isUserLoggedIn: jest.fn(),
};

const mockKeyRouter: any = {
  isCloudKey: (key: string) => key === 'settings',
};

const mockDeps = {
  storageManager: mockStorageManager,
  syncEngine: mockSyncEngine,
  firestoreManager: {},
  networkMonitor: { destroy: jest.fn() },
  userManager: mockUserManager,
  keyRouter: mockKeyRouter,
};

const baseConfig: GanonConfig<TestStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: [], subcollectionKeys: ['settings'] },
  },
  autoStartSync: false,
};

describe('Ganon whenHydrated lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedInternalConfig = undefined;
    mockUserManager.getCurrentUser.mockReturnValue(undefined);
    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    mockStorageManager.get.mockReturnValue(undefined);
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
  });

  function createGanon(overrides: Partial<GanonConfig<TestStorage>> = {}): Ganon<TestStorage> {
    return new Ganon<TestStorage>({ ...baseConfig, ...overrides });
  }

  it('is pending before first login', async () => {
    const ganon = createGanon();
    let settled = false;
    void ganon.whenHydrated().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('resolves pending waiters on logout instead of dangling', async () => {
    const ganon = createGanon({ autoStartSync: false });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncEngine.restore.mockImplementation(() => new Promise(() => {}));
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') {
        mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
      }
    });

    void ganon.login('u1');
    await Promise.resolve();

    let settled = false;
    void ganon.whenHydrated().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    await ganon.logout({ backup: false });

    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('is pending during login restore until restore settles (autoStartSync off)', async () => {
    const ganon = createGanon({ autoStartSync: false });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncEngine.restore.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 25));
      return { success: true, restoredKeys: ['settings'], failedKeys: [], integrityFailures: [] };
    });

    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
    });

    const loginPromise = ganon.login('u1');
    await Promise.resolve();

    let settled = false;
    void ganon.whenHydrated().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await loginPromise;
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('earlyWriteGuard and whenHydrated share hydration-pending (throws on consumer set during login restore)', async () => {
    const ganon = createGanon({ autoStartSync: false, earlyWriteGuard: 'throw' });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
    });

    mockSyncEngine.restore.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30));
      return { success: true, restoredKeys: ['settings'], failedKeys: [], integrityFailures: [] };
    });

    const loginPromise = ganon.login('u1');
    await Promise.resolve();

    expect(() => ganon.set('settings', { theme: 'dark' })).toThrow(SyncError);
    await expect(loginPromise).resolves.toBe('restore');
  });

  it('login with restore completes under earlyWriteGuard throw (internal restore bypasses public set)', async () => {
    const ganon = createGanon({ autoStartSync: true, earlyWriteGuard: 'throw' });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
    });
    mockSyncEngine.start.mockImplementation(() => {
      capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
      });
    });

    await expect(ganon.login('u1')).resolves.toBe('restore');
    await expect(ganon.whenHydrated()).resolves.toBeUndefined();
  });
});
