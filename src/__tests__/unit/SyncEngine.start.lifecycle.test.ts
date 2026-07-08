import SyncEngine, { MARK_AS_PENDING_DEBOUNCE_MS } from '../../sync/SyncEngine';
import StorageManager from '../../managers/StorageManager';
import FirestoreManager from '../../firestore/FirestoreManager';
import OperationRepo from '../../sync/OperationRepo';
import MetadataManager from '../../metadata/MetadataManager';
import UserManager from '../../managers/UserManager';
import { GanonConfig } from '../../models/config/GanonConfig';
import { IntegrityFailureRecoveryStrategy } from '../../models/config/IntegrityFailureRecoveryStrategy';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { FakeScheduler } from '../utils/FakeScheduler';
import computeHash from '../../utils/computeHash';
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
  configOverrides: Partial<GanonConfig<TestStorage>> = {},
  deps?: {
    storage?: StorageManager<TestStorage>;
    metadataManager?: MetadataManager<TestStorage>;
    firestore?: FirestoreManager<TestStorage>;
    userManager?: UserManager<TestStorage>;
  }
): SyncEngine<TestStorage> {
  const config: GanonConfig<TestStorage> = {
    identifierKey: 'email',
    cloudConfig,
    syncInterval: 1000,
    ...configOverrides,
  };
  const storage = deps?.storage ?? createMockStorageManager<TestStorage>();
  const userManager = deps?.userManager ?? createMockUserManager<TestStorage>();
  userManager.isUserLoggedIn.mockReturnValue(true);
  return new SyncEngine(
    storage,
    deps?.firestore ?? createMockFirestoreManager<TestStorage>(),
    deps?.metadataManager ?? createMockMetadataManager<TestStorage>(),
    { addOperation: jest.fn() } as unknown as OperationRepo<TestStorage>,
    userManager,
    config,
    undefined,
    scheduler
  );
}

describe('SyncEngine start/stop lifecycle', () => {
  it('double start() arms exactly one sync interval and does not re-fire hydrate', () => {
    const scheduler = new FakeScheduler();
    const repeatSpy = jest.spyOn(scheduler, 'repeat');
    const engine = createEngine(scheduler, { autoStartSync: true });
    const hydrateSpy = jest
      .spyOn(engine, 'hydrate')
      .mockResolvedValue({ success: true, restoredKeys: [], failedKeys: [], integrityFailures: [] });

    engine.start();
    engine.start();

    expect(repeatSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    engine.stop();
    hydrateSpy.mockRestore();
  });

  it('start → stop → start re-arms interval and hydrate', () => {
    const scheduler = new FakeScheduler();
    const repeatSpy = jest.spyOn(scheduler, 'repeat');
    const engine = createEngine(scheduler, { autoStartSync: true });
    const hydrateSpy = jest
      .spyOn(engine, 'hydrate')
      .mockResolvedValue({ success: true, restoredKeys: [], failedKeys: [], integrityFailures: [] });

    engine.start();
    expect(repeatSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    expect((engine as any).syncIntervalHandle).toBeNull();

    engine.start();
    expect(repeatSpy).toHaveBeenCalledTimes(2);
    expect(hydrateSpy).toHaveBeenCalledTimes(2);

    engine.stop();
    hydrateSpy.mockRestore();
  });

  it('logout teardown stop() allows login start() to re-arm (running-state semantics)', () => {
    const scheduler = new FakeScheduler();
    const engine = createEngine(scheduler, { autoStartSync: true });
    const repeatSpy = jest.spyOn(scheduler, 'repeat');

    engine.start();
    engine.stop();

    engine.start();
    expect(repeatSpy).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it('stale in-flight hydrate cannot write after stop() invalidates the session', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    let releaseFetch!: (value: string) => void;
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve;
    });

    const remoteValue = 'stale-remote-value';
    const remoteDigest = computeHash(remoteValue);

    metadataManager.needsHydration.mockResolvedValue(true);
    metadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: 'local-digest',
      version: 1,
    });
    metadataManager.getRemoteMetadataOnly.mockResolvedValue({
      digest: remoteDigest,
      version: 2,
    });
    firestore.fetch.mockImplementation(() => fetchGate);

    const engine = createEngine(
      scheduler,
      { autoStartSync: false },
      { storage, metadataManager, firestore, userManager }
    );

    const hydratePromise = engine.hydrate();
    await Promise.resolve();

    engine.stop();

    releaseFetch(remoteValue);
    await hydratePromise;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(storage.set).not.toHaveBeenCalled();
    expect(metadataManager.recordSyncedState).not.toHaveBeenCalled();
  });

  it('hydrate() after stop() runs a fresh pass instead of returning the stale dedupe promise', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    let releaseFetch!: (value: string) => void;
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve;
    });

    const remoteValue = 'fresh-remote-value';
    const remoteDigest = computeHash(remoteValue);

    metadataManager.needsHydration.mockResolvedValue(true);
    metadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: 'local-digest',
      version: 1,
    });
    metadataManager.getRemoteMetadataOnly.mockResolvedValue({
      digest: remoteDigest,
      version: 2,
    });
    // First (stale) pass blocks on the gate; the fresh pass resolves immediately.
    firestore.fetch
      .mockImplementationOnce(() => fetchGate)
      .mockImplementation(() => Promise.resolve(remoteValue));

    const engine = createEngine(
      scheduler,
      { autoStartSync: false },
      { storage, metadataManager, firestore, userManager }
    );

    // Session A: hydrate begins and blocks with hydrationPromise set.
    const firstHydrate = engine.hydrate();
    await Promise.resolve();
    expect(firestore.fetch).toHaveBeenCalledTimes(1);

    // Logout: stop() must release the dedupe handle so a re-login runs a fresh pass.
    engine.stop();

    // Session B: new hydrate BEFORE the stale fetch is released. If stop() had not nulled
    // hydrationPromise, this would short-circuit and return the generation-dead stale promise.
    const secondHydrate = engine.hydrate();
    await secondHydrate;

    // Fresh pass actually ran: fetch/needsHydration re-invoked and the new value was written.
    expect(firestore.fetch).toHaveBeenCalledTimes(2);
    expect(metadataManager.needsHydration).toHaveBeenCalledTimes(2);
    expect(storage.set).toHaveBeenCalledWith('key1', remoteValue);

    storage.set.mockClear();

    // The orphaned stale pass resolving late must not write nor clobber the fresh handle.
    releaseFetch(remoteValue);
    await firstHydrate;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(storage.set).not.toHaveBeenCalled();
  });

  it('stale in-flight hydrate cannot recover via integrity failure after stop()', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    let releaseFetch!: (value: string) => void;
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve;
    });

    const remoteValue = 'integrity-mismatch-value';
    const integrityConfig = {
      maxRetries: 1,
      strategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH,
    };

    metadataManager.needsHydration.mockResolvedValue(true);
    metadataManager.get.mockReturnValue(undefined);
    metadataManager.getRemoteMetadataOnly.mockResolvedValue({
      digest: 'metadata-digest-does-not-match-value',
      version: 2,
    });
    firestore.fetch.mockImplementation(() => fetchGate);

    const engine = createEngine(
      scheduler,
      { autoStartSync: false, integrityFailureConfig: integrityConfig },
      { storage, metadataManager, firestore, userManager }
    );

    const hydratePromise = engine.hydrate(undefined, undefined, integrityConfig);
    await Promise.resolve();

    engine.stop();

    releaseFetch(remoteValue);
    await hydratePromise;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(firestore.fetch).toHaveBeenCalledTimes(1);
    expect(storage.set).not.toHaveBeenCalled();
    expect(metadataManager.recordSyncedState).not.toHaveBeenCalled();
    expect(metadataManager.recordLocalChange).not.toHaveBeenCalled();
  });

  it('stop() invalidates remote metadata caches without cancelPendingOperations', () => {
    const scheduler = new FakeScheduler();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const engine = createEngine(
      scheduler,
      { autoStartSync: false },
      { metadataManager }
    );

    engine.stop();

    expect(metadataManager.invalidateAllRemoteCaches).toHaveBeenCalled();
    expect(metadataManager.cancelPendingOperations).not.toHaveBeenCalled();
  });

  it('stale in-flight restore cannot write after stop() invalidates the session', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    let releaseFetch!: (value: string) => void;
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve;
    });

    const remoteValue = 'stale-restore-value';

    metadataManager.hydrateMetadata.mockResolvedValue(undefined);
    firestore.fetch.mockImplementation(() => fetchGate);

    const engine = createEngine(
      scheduler,
      { autoStartSync: false },
      { storage, metadataManager, firestore, userManager }
    );

    const restorePromise = engine.restore();
    await Promise.resolve();

    engine.stop();

    releaseFetch(remoteValue);
    await restorePromise;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(storage.set).not.toHaveBeenCalled();
    expect(metadataManager.recordSyncedState).not.toHaveBeenCalled();
    expect(firestore.fetch).toHaveBeenCalledTimes(1);
  });

  it('stale in-flight forceHydrate cannot recover via integrity failure after stop()', async () => {
    const scheduler = new FakeScheduler();
    const storage = createMockStorageManager<TestStorage>();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const firestore = createMockFirestoreManager<TestStorage>();
    const userManager = createMockUserManager<TestStorage>();
    userManager.isUserLoggedIn.mockReturnValue(true);

    let releaseFetch!: (value: string) => void;
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve;
    });

    const remoteValue = 'integrity-mismatch-value';
    const integrityConfig = {
      maxRetries: 1,
      strategy: IntegrityFailureRecoveryStrategy.FORCE_REFRESH,
    };

    metadataManager.get.mockReturnValue(undefined);
    metadataManager.getRemoteMetadataOnly.mockResolvedValue({
      digest: 'metadata-digest-does-not-match-value',
      version: 2,
    });
    firestore.fetch.mockImplementation(() => fetchGate);

    const engine = createEngine(
      scheduler,
      { autoStartSync: false, integrityFailureConfig: integrityConfig },
      { storage, metadataManager, firestore, userManager }
    );

    const hydratePromise = engine.forceHydrate(['key1'], undefined, integrityConfig);
    await Promise.resolve();

    engine.stop();

    releaseFetch(remoteValue);
    await hydratePromise;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(firestore.fetch).toHaveBeenCalledTimes(1);
    expect(storage.set).not.toHaveBeenCalled();
    expect(metadataManager.recordSyncedState).not.toHaveBeenCalled();
    expect(metadataManager.recordLocalChange).not.toHaveBeenCalled();
  });
});

describe('SyncEngine markAsPending autoStartSync default (PR #4 regression)', () => {
  it('omitted autoStartSync uses recordLocalChange through _processMarkAsPending', async () => {
    const scheduler = new FakeScheduler();
    const metadataManager = createMockMetadataManager<TestStorage>();
    const storage = createMockStorageManager<TestStorage>();
    storage.get.mockReturnValue('changed');
    metadataManager.get.mockReturnValue({
      syncStatus: SyncStatus.Synced,
      digest: 'old-digest',
      version: 1,
    });

    const config: GanonConfig<TestStorage> = {
      identifierKey: 'email',
      cloudConfig,
    };

    const engine = new SyncEngine(
      storage,
      createMockFirestoreManager<TestStorage>(),
      metadataManager,
      { addOperation: jest.fn() } as unknown as OperationRepo<TestStorage>,
      createMockUserManager<TestStorage>(),
      config,
      undefined,
      scheduler
    );

    engine.markAsPending('key1');
    scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(metadataManager.recordLocalChange).toHaveBeenCalled();
    expect(metadataManager.persistLocalChange).not.toHaveBeenCalled();
  });
});
