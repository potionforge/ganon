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
  stop: jest.fn(),
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
  hydrate: jest.fn().mockResolvedValue({
    success: true,
    restoredKeys: [],
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
    let reason: string | undefined;
    void ganon.whenHydrated().then(r => {
      settled = true;
      reason = r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    await ganon.logout({ backup: false });

    await Promise.resolve();
    expect(settled).toBe(true);
    expect(reason).toBe('logged-out');
  });

  it('logged-out hydrate() does not settle pre-login whenHydrated() waiters', async () => {
    const ganon = createGanon({ autoStartSync: false });
    mockUserManager.isUserLoggedIn.mockReturnValue(false);

    let settled = false;
    void ganon.whenHydrated().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    mockSyncEngine.hydrate.mockImplementation(async () => {
      capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
      });
      return {
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
      };
    });

    await ganon.hydrate();
    await Promise.resolve();
    expect(settled).toBe(false);
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
    let reason: string | undefined;
    void ganon.whenHydrated().then(r => {
      settled = true;
      reason = r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await loginPromise;
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(reason).toBe('hydrated');
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

  it('resolves whenHydrated waiters when hydrate rejects after onHydrationComplete', async () => {
    const ganon = createGanon({ autoStartSync: true });
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
    });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: ['settings'],
      failedKeys: [],
      integrityFailures: [],
    });
    mockSyncEngine.hydrate.mockImplementation(async () => {
      capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
        success: false,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
        timestamp: new Date(),
      });
      throw new Error('hydrate failed');
    });
    mockSyncEngine.start.mockImplementation(() => {
      void mockSyncEngine.hydrate().catch(() => {});
    });

    void ganon.login('u1');
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
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
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
  });

  it('stopSync() resolves pending whenHydrated() waiters with stopped', async () => {
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
    const waiter = ganon.whenHydrated().then(r => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ganon.stopSync();
    await expect(waiter).resolves.toBe('stopped');
  });

  it('destroy() resolves pending whenHydrated() waiters with stopped', async () => {
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

    const waiter = ganon.whenHydrated();
    ganon.destroy();

    await expect(waiter).resolves.toBe('stopped');
  });

  it('logout settles logged-out once without stopSync double-settlement', async () => {
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

    const reasons: string[] = [];
    void ganon.whenHydrated().then(r => reasons.push(r));

    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    await ganon.logout({ backup: false });

    expect(reasons).toEqual(['logged-out']);
  });

  it('same login after stopSync: late whenHydrated stays stopped until startSync completes hydration', async () => {
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

    ganon.stopSync();
    await expect(ganon.whenHydrated()).resolves.toBe('stopped');

    mockSyncEngine.start.mockImplementation(() => {
      capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
      });
    });

    ganon.startSync();
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
  });

  it('stopSync after hydration completed: startSync re-arm blocks whenHydrated until resumed pass settles', async () => {
    const ganon = createGanon({ autoStartSync: true });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') {
        mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
      }
    });
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: ['settings'],
      failedKeys: [],
      integrityFailures: [],
    });

    let autoComplete = true;
    mockSyncEngine.start.mockImplementation(() => {
      if (autoComplete) {
        capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
          success: true,
          restoredKeys: [],
          failedKeys: [],
          integrityFailures: [],
        });
      }
    });

    // Initial login hydrates to completion — settle reason is 'hydrated'.
    await ganon.login('u1');
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');

    // Stop AFTER hydration already settled: no pending waiters, reason stays 'hydrated'.
    ganon.stopSync();

    // Resume: the re-fired hydrate pass is still running (does not auto-complete).
    autoComplete = false;
    ganon.startSync();

    // Regression guard: whenHydrated() must NOT report 'hydrated' while the resumed pass runs.
    let resolved = false;
    const waiter = ganon.whenHydrated().then(r => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Completing the resumed pass settles the waiter honestly.
    capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
      success: true,
      restoredKeys: [],
      failedKeys: [],
      integrityFailures: [],
    });
    await expect(waiter).resolves.toBe('hydrated');
  });

  it('logout after stopSync resets stopped reason so re-login reaches hydrated', async () => {
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
    ganon.stopSync();
    await expect(ganon.whenHydrated()).resolves.toBe('stopped');

    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    await ganon.logout({ backup: false });

    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: ['settings'],
      failedKeys: [],
      integrityFailures: [],
    });

    await ganon.login('u2');
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
  });

  it('after stopSync then start() hydration completes a new waiter resolves hydrated', async () => {
    const ganon = createGanon({ autoStartSync: true });
    mockSyncEngine.hasAnyRemoteData.mockResolvedValue(true);
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);
    mockStorageManager.set.mockImplementation((key: string, value: string) => {
      if (key === 'email') {
        mockStorageManager.get.mockImplementation((k: string) => (k === 'email' ? value : undefined));
      }
    });
    mockSyncEngine.restore.mockResolvedValue({
      success: true,
      restoredKeys: ['settings'],
      failedKeys: [],
      integrityFailures: [],
    });

    let startCount = 0;
    mockSyncEngine.start.mockImplementation(() => {
      startCount += 1;
      if (startCount === 1) {
        return;
      }
      capturedInternalConfig?.eventCallbacks?.onHydrationComplete?.({
        success: true,
        restoredKeys: [],
        failedKeys: [],
        integrityFailures: [],
      });
    });

    void ganon.login('u1');
    await Promise.resolve();

    const stoppedWaiter = ganon.whenHydrated();
    ganon.stopSync();
    await expect(stoppedWaiter).resolves.toBe('stopped');

    mockUserManager.getCurrentUser.mockReturnValue(undefined);
    mockStorageManager.get.mockReturnValue(undefined);
    mockUserManager.isUserLoggedIn.mockImplementation(() => mockStorageManager.get('email') != null);

    await ganon.login('u2');
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
  });
});
