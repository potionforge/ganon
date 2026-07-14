import SyncEngine from '../../sync/SyncEngine';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import OperationRepo from '../../sync/OperationRepo';
import MetadataManager from '../../metadata/MetadataManager';
import UserManager from '../../managers/UserManager';
import NetworkMonitor from '../../utils/NetworkMonitor';
import { GanonConfig } from '../../models/config/GanonConfig';
import { SyncStatus } from '../../models/sync/SyncStatus';
import computeHash from '../../utils/computeHash';
import { FakeScheduler } from '../utils/FakeScheduler';
import {
  createMockFirestoreManager,
  createMockMetadataManager,
  createMockStorageManager,
  createMockUserManager,
} from '../utils/TestSetupUtils';

jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

interface TestStorage {
  email: string;
  key1: string;
  lastBackup: number;
}

const cloudConfig = {
  profile: { docKeys: ['key1'] as Extract<keyof TestStorage, string>[], subcollectionKeys: [] },
};

function createEngine(
  scheduler: FakeScheduler,
  deps: {
    storage: StorageManager<TestStorage>;
    metadataManager: MetadataManager<TestStorage>;
    firestore: FirestoreManager<TestStorage>;
    operationRepo: OperationRepo<TestStorage>;
    userManager: UserManager<TestStorage>;
  }
): SyncEngine<TestStorage> {
  const config: GanonConfig<TestStorage> = {
    identifierKey: 'email',
    cloudConfig,
    autoStartSync: true,
  };

  return new SyncEngine(
    deps.storage,
    deps.firestore,
    deps.metadataManager,
    deps.operationRepo,
    deps.userManager,
    config,
    undefined,
    scheduler
  );
}

describe('SyncEngine.syncAll pending-mark flush', () => {
  it('processes digest-detected changes without advancing the mark debounce scheduler', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    const editedValue = 'edited-before-logout';
    storage.contains.mockReturnValue(true);
    storage.get.mockReturnValue(editedValue);

    const staleDigest = 'stale-digest';
    metadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: staleDigest,
      version: 1,
    });
    metadataManager.recordLocalChange.mockResolvedValue(undefined);

    const networkMonitor = { isOnline: () => true } as NetworkMonitor;
    const operationRepo = new OperationRepo<TestStorage>(networkMonitor, {
      storage,
      firestore,
      metadataManager,
    });

    const engine = createEngine(scheduler, {
      storage,
      metadataManager,
      firestore,
      operationRepo,
      userManager,
    });

    const result = await engine.syncAll();

    expect(firestore.syncValueWithDigest).toHaveBeenCalledWith(
      'key1',
      editedValue,
      computeHash(editedValue),
      expect.any(Number)
    );
    expect(result.backedUpKeys).toContain('key1');
    expect(result.success).toBe(true);
  });

  it('flushes a user edit still sitting in the markAsPending debounce window', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    const editedValue = 'just-edited';
    storage.contains.mockReturnValue(true);
    storage.get.mockReturnValue(editedValue);

    metadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: 'old-digest',
      version: 1,
    });
    metadataManager.recordLocalChange.mockResolvedValue(undefined);

    const networkMonitor = { isOnline: () => true } as NetworkMonitor;
    const operationRepo = new OperationRepo<TestStorage>(networkMonitor, {
      storage,
      firestore,
      metadataManager,
    });

    const engine = createEngine(scheduler, {
      storage,
      metadataManager,
      firestore,
      operationRepo,
      userManager,
    });

    engine.markAsPending('key1');
    // Do not advance scheduler — debounce has not fired.

    const result = await engine.syncAll();

    expect(firestore.syncValueWithDigest).toHaveBeenCalledWith(
      'key1',
      editedValue,
      computeHash(editedValue),
      expect.any(Number)
    );
    expect(result.backedUpKeys).toContain('key1');
  });
});
