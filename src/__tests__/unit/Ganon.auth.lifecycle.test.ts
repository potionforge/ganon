import { jest } from '@jest/globals';
import Ganon from '../../Ganon';
import SyncEngine from '../../sync/SyncEngine';
import { GanonConfig, InternalGanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';
import { FakeScheduler } from '../utils/FakeScheduler';
import { SyncStatus } from '../../models/sync/SyncStatus';

jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

interface TestStorage extends BaseStorageMapping {
  email: string;
  key1: string;
}

let capturedInternalConfig: InternalGanonConfig<TestStorage> | undefined;
let realSyncEngine: SyncEngine<TestStorage>;
const fakeScheduler = new FakeScheduler();

const mockStorageManager: any = {
  get: jest.fn(),
  set: jest.fn(),
  remove: jest.fn(),
  contains: jest.fn(),
  clearAllData: jest.fn(),
};

const mockFirestoreManager: any = {
  fetch: jest.fn().mockResolvedValue(undefined),
  backup: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
  backupLastBackupToUserDocument: jest.fn().mockResolvedValue(undefined),
  cloudConfig: {
    profile: { docKeys: ['key1'], subcollectionKeys: [] },
  },
};

const mockMetadataManager: any = {
  get: jest.fn(),
  getRemoteMetadataOnly: jest.fn().mockResolvedValue(undefined),
  needsHydration: jest.fn().mockResolvedValue(false),
  recordLocalChange: jest.fn().mockResolvedValue(undefined),
  persistLocalChange: jest.fn().mockResolvedValue(undefined),
  recordSyncedState: jest.fn().mockResolvedValue(undefined),
  hydrateMetadata: jest.fn().mockResolvedValue(undefined),
  getRemoteMetaForKey: jest.fn(),
  invalidateCache: jest.fn(),
  invalidateCacheForHydration: jest.fn(),
  cancelPendingOperations: jest.fn(),
  isNeverSynced: jest.fn().mockReturnValue(false),
};

const mockOperationRepo: any = {
  addOperation: jest.fn(),
  processOperations: jest.fn().mockResolvedValue([{ success: true, key: 'key1' }]),
  hasPendingOperations: jest.fn().mockReturnValue(false),
  clearAll: jest.fn(),
};

const mockUserManager: any = {
  getCurrentUser: jest.fn(),
  isUserLoggedIn: jest.fn(),
};

const mockNetworkMonitor: any = { destroy: jest.fn() };

const mockKeyRouter: any = {
  isCloudKey: (key: string) => key === 'key1',
};

jest.mock('../../factory/DependencyFactory', () => {
  return jest.fn().mockImplementation((cfg: InternalGanonConfig<TestStorage>) => {
    capturedInternalConfig = cfg;
    realSyncEngine = new SyncEngine(
      mockStorageManager,
      mockFirestoreManager,
      mockMetadataManager,
      mockOperationRepo,
      mockUserManager,
      cfg,
      undefined,
      fakeScheduler
    );
    return {
      getDependencies: () => ({
        storageManager: mockStorageManager,
        syncEngine: realSyncEngine,
        firestoreManager: mockFirestoreManager,
        networkMonitor: mockNetworkMonitor,
        userManager: mockUserManager,
        keyRouter: mockKeyRouter,
      }),
    };
  });
});

const baseConfig: GanonConfig<TestStorage> = {
  identifierKey: 'email',
  cloudConfig: {
    profile: { docKeys: ['key1'], subcollectionKeys: [] },
  },
  autoStartSync: true,
  syncInterval: 1000,
};

function wireLoggedInState(userId: string | undefined): void {
  mockStorageManager.get.mockImplementation((key: string) => {
    if (key === 'email') return userId;
    if (key === 'key1') return 'local-value';
    return undefined;
  });
  mockStorageManager.contains.mockImplementation((key: string) => key === 'key1');
  mockStorageManager.set.mockImplementation((key: string, value: string) => {
    if (key === 'email') {
      wireLoggedInState(value);
    }
  });
  mockUserManager.getCurrentUser.mockImplementation(() => userId);
  mockUserManager.isUserLoggedIn.mockImplementation(() => userId != null);
  mockMetadataManager.get.mockReturnValue({
    syncStatus: SyncStatus.Synced,
    digest: 'existing-digest',
    version: 1,
  });
}

describe('Ganon auth lifecycle (unmocked SyncEngine)', () => {
  let ganon: Ganon<TestStorage>;
  let startSyncIntervalSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedInternalConfig = undefined;
    fakeScheduler.advance(0);
    wireLoggedInState(undefined);
    startSyncIntervalSpy = jest.spyOn(SyncEngine.prototype, 'startSyncInterval');
    ganon = new Ganon<TestStorage>(baseConfig);
  });

  afterEach(() => {
    startSyncIntervalSpy.mockRestore();
    realSyncEngine?.stopSyncInterval();
  });

  it('login → logout → login restarts sync interval and whenHydrated() resolves', async () => {
    mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue(undefined);

    await ganon.login('user1@example.com');
    expect(startSyncIntervalSpy).toHaveBeenCalledTimes(1);
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');

    await ganon.logout({ backup: false });
    expect((realSyncEngine as any).syncIntervalHandle).toBeNull();

    startSyncIntervalSpy.mockClear();
    await ganon.login('user2@example.com');
    expect(startSyncIntervalSpy).toHaveBeenCalledTimes(1);
    expect((realSyncEngine as any).syncIntervalHandle).not.toBeNull();
    await expect(ganon.whenHydrated()).resolves.toBe('hydrated');
  });

  it('logged-out hydrate() does not settle pre-login whenHydrated() waiters', async () => {
    ganon = new Ganon<TestStorage>({ ...baseConfig, autoStartSync: false });

    let settled = false;
    void ganon.whenHydrated().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await ganon.hydrate();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('markAsPending with omitted autoStartSync schedules remote metadata flush', () => {
    const scheduler = new FakeScheduler();
    const configWithoutAutoStart: GanonConfig<TestStorage> = {
      identifierKey: 'email',
      cloudConfig: baseConfig.cloudConfig,
    };
    const engine = new SyncEngine(
      mockStorageManager,
      mockFirestoreManager,
      mockMetadataManager,
      mockOperationRepo,
      mockUserManager,
      configWithoutAutoStart,
      undefined,
      scheduler
    );

    mockStorageManager.get.mockReturnValue('changed-value');
    mockMetadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: 'old-digest',
      version: 1,
    });

    engine.markAsPending('key1');
    scheduler.advance(50);

    expect(mockMetadataManager.recordLocalChange).toHaveBeenCalled();
    expect(mockMetadataManager.persistLocalChange).not.toHaveBeenCalled();
    engine.stopSyncInterval();
  });

  it('login failure settles pre-registered waiters as login-failed and unblocks earlyWriteGuard', async () => {
    const ganon = new Ganon<TestStorage>({ ...baseConfig, earlyWriteGuard: 'throw' });
    mockMetadataManager.getRemoteMetadataOnly.mockResolvedValue({ digest: 'd', version: 1 });
    jest.spyOn(realSyncEngine, 'restore').mockRejectedValue(new Error('restore failed'));

    let reason: string | undefined;
    const hydratedPromise = ganon.whenHydrated().then(r => {
      reason = r;
    });

    const loginPromise = ganon.login('user1@example.com');
    await expect(loginPromise).rejects.toThrow('restore failed');
    await hydratedPromise;

    expect(reason).toBe('login-failed');
    expect(() => ganon.set('key1', 'after-failure')).not.toThrow();
  });

  it('rejects cloudConfig docKeys that collide with reserved digest namespaces', () => {
    const reservedKeys = ['digestMap', 'remote_metadata', '_sync_metadata_'] as const;
    for (const key of reservedKeys) {
      expect(() =>
        new Ganon<TestStorage>({
          identifierKey: 'email',
          cloudConfig: { profile: { docKeys: [key], subcollectionKeys: [] } },
          autoStartSync: false,
        })
      ).toThrow(/collides with reserved/);
    }
  });
});
