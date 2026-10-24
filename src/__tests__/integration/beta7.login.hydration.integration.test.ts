/**
 * beta-7: real SyncEngine + FakeFirestore login/stop gating and hydration metadata freshness.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import Ganon from '../../Ganon';
import SyncEngine from '../../sync/SyncEngine';
import { MARK_AS_PENDING_DEBOUNCE_MS } from '../../sync/SyncEngine';
import { GanonConfig } from '../../models/config/GanonConfig';
import computeHash from '../../utils/computeHash';
import { DIGEST_MAP_KEY, REMOTE_METADATA_KEY } from '../../constants';
import {
  SIX_TWO_CLOUD_CONFIG,
  SIX_TWO_USER,
  SixTwoStorage,
  createSixTwoStack,
  seedRemoteProfile,
} from '../utils/sixTwoIntegrationHarness';

let harness = createSixTwoStack({
  identifierKey: 'email',
  cloudConfig: SIX_TWO_CLOUD_CONFIG,
  autoStartSync: true,
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
  autoStartSync: true,
  syncInterval: 60_000,
};

function isSyncEngineRunning(): boolean {
  return (harness.syncEngine as unknown as { running: boolean }).running;
}

function profileCoordinatorRefreshSpy(): jest.SpyInstance {
  const coordinator = (harness.metadataManager as unknown as {
    coordinatorRepo: { getCoordinator: (name: string) => { refreshCache: () => Promise<void> } };
  }).coordinatorRepo.getCoordinator('profile');
  return jest.spyOn(coordinator, 'refreshCache');
}

describe('beta-7 login stop gating (real SyncEngine + FakeScheduler)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack(baseConfig);
    jest.spyOn(harness.adapter, 'getDocument');
    jest.spyOn(harness.adapter, 'setDocument');
    jest.spyOn(harness.adapter, 'setDocumentWithTransaction');
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('stopSync during backup arm leaves engine stopped after login resolves', async () => {
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    harness.storage.set('alpha', 'guest-alpha');
    const startSpy = jest.spyOn(harness.syncEngine, 'start');

    let releaseBackup!: () => void;
    const backupGate = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const realSyncAll = harness.syncEngine.syncAll.bind(harness.syncEngine);
    jest.spyOn(harness.syncEngine, 'syncAll').mockImplementation(async () => {
      await backupGate;
      return realSyncAll();
    });

    const loginPromise = ganon.login(SIX_TWO_USER);
    await Promise.resolve();
    ganon.stopSync();
    releaseBackup();
    harness.scheduler.advance(60_000);
    await loginPromise;

    expect(startSpy).not.toHaveBeenCalled();
    expect(isSyncEngineRunning()).toBe(false);
    await expect(ganon.whenHydrated()).resolves.toBe('stopped');

    startSpy.mockClear();
    const hydrateSpy = jest.spyOn(harness.syncEngine, 'hydrate');
    ganon.startSync();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalled();
    ganon.destroy();
  });

  it('stopSync after restore completes (present arm) does not restart sync on login', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    const realRestore = harness.syncEngine.restore.bind(harness.syncEngine);
    let interleaveStopOnce = false;
    jest.spyOn(harness.syncEngine, 'restore').mockImplementation(async () => {
      const result = await realRestore();
      if (!interleaveStopOnce) {
        interleaveStopOnce = true;
        ganon.stopSync();
      }
      return result;
    });

    const startSpy = jest.spyOn(harness.syncEngine, 'start');
    await ganon.login(SIX_TWO_USER);
    expect(startSpy).not.toHaveBeenCalled();
    expect(isSyncEngineRunning()).toBe(false);
    await expect(ganon.whenHydrated()).resolves.toBe('stopped');

    startSpy.mockClear();
    const hydrateSpy = jest.spyOn(harness.syncEngine, 'hydrate');
    await ganon.login('user-resume2@example.com');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalled();
    expect(isSyncEngineRunning()).toBe(true);
    ganon.destroy();
  });

  it('indeterminate arm with aborted restore leaves engine stopped; next login re-hydrates', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    const ganon = new Ganon<SixTwoStorage>(baseConfig);
    jest
      .spyOn(harness.syncEngine, 'probeRemoteData')
      .mockResolvedValueOnce({ status: 'indeterminate', reason: 'probe flaky' });

    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const realRestore = harness.syncEngine.restore.bind(harness.syncEngine);
    jest.spyOn(harness.syncEngine, 'restore').mockImplementation(async () => {
      await restoreGate;
      return realRestore();
    });

    const startSpy = jest.spyOn(harness.syncEngine, 'start');
    const loginPromise = ganon.login(SIX_TWO_USER);
    await Promise.resolve();
    ganon.stopSync();
    releaseRestore();
    harness.scheduler.advance(60_000);
    await loginPromise;

    expect(startSpy).not.toHaveBeenCalled();
    expect(isSyncEngineRunning()).toBe(false);
    await expect(ganon.whenHydrated()).resolves.toBe('stopped');

    startSpy.mockClear();
    const hydrateSpy = jest.spyOn(harness.syncEngine, 'hydrate');
    await ganon.login('user-resume3@example.com');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalled();
    ganon.destroy();
  });
});

describe('beta-7 hydrate metadata freshness (FakeFirestore)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack({
      ...baseConfig,
      autoStartSync: false,
    });
    jest.spyOn(harness.adapter, 'getDocument');
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  function bumpRemoteAlpha(nextValue: string): void {
    const doc = harness.fake.getDocument(harness.profileBackupPath)!;
    const meta = { ...(doc[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>) };
    meta.alpha = { d: computeHash(nextValue), v: (meta.alpha?.v ?? 500) + 1 };
    harness.fake.setDocument(harness.profileBackupPath, {
      ...doc,
      alpha: nextValue,
      [REMOTE_METADATA_KEY]: meta,
      [DIGEST_MAP_KEY]: meta,
    });
  }

  it('hydrate() within metadata TTL picks up remote edits with one metadata doc read at pass start', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    harness.storage.set('email', SIX_TWO_USER);
    await harness.syncEngine.restore();

    bumpRemoteAlpha('remote-alpha-v2');
    const refreshSpy = profileCoordinatorRefreshSpy();
    refreshSpy.mockClear();

    const result = await harness.syncEngine.hydrate();
    expect(result.restoredKeys).toContain('alpha');
    expect(harness.storage.get('alpha')).toBe('remote-alpha-v2');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('forceHydrate() within metadata TTL picks up remote edits with one metadata doc read at pass start', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    harness.storage.set('email', SIX_TWO_USER);
    await harness.syncEngine.restore();

    bumpRemoteAlpha('remote-alpha-v2');
    const refreshSpy = profileCoordinatorRefreshSpy();
    refreshSpy.mockClear();

    const result = await harness.syncEngine.forceHydrate(['alpha']);
    expect(result.restoredKeys).toContain('alpha');
    expect(harness.storage.get('alpha')).toBe('remote-alpha-v2');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

describe('beta-7 hydration dedupe and syncPending deferral (real SyncEngine)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    harness = createSixTwoStack({
      ...baseConfig,
      autoStartSync: false,
    });
  });

  afterEach(() => {
    harness.syncEngine.stopSyncInterval();
  });

  it('two concurrent hydrate() calls dedupe metadata refresh and key processing', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    harness.storage.set('email', SIX_TWO_USER);
    await harness.syncEngine.restore();

    let releaseMeta!: () => void;
    const metaGate = new Promise<void>((resolve) => {
      releaseMeta = resolve;
    });
    const realHydrateMetadata = harness.metadataManager.hydrateMetadata.bind(harness.metadataManager);
    const hydrateMetadataSpy = jest
      .spyOn(harness.metadataManager, 'hydrateMetadata')
      .mockImplementation(async (session) => {
        await metaGate;
        return realHydrateMetadata(session);
      });
    const processKeysSpy = jest.spyOn(
      harness.syncEngine as unknown as { _processKeys: (...args: unknown[]) => Promise<unknown> },
      '_processKeys'
    );

    const first = harness.syncEngine.hydrate();
    const second = harness.syncEngine.hydrate();
    await Promise.resolve();
    expect((harness.syncEngine as unknown as { hydrationPromise: Promise<unknown> | null }).hydrationPromise).not.toBeNull();
    expect(hydrateMetadataSpy).toHaveBeenCalledTimes(1);
    expect(processKeysSpy).not.toHaveBeenCalled();

    releaseMeta();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual(r2);
    expect(processKeysSpy).toHaveBeenCalledTimes(1);
  });

  it('syncPending() defers until pass-start metadata fetch completes', async () => {
    seedRemoteProfile(harness.fake, SIX_TWO_USER, {
      alpha: 'remote-alpha',
      beta: 'remote-beta',
      gamma: 'remote-gamma',
    });
    harness.storage.set('email', SIX_TWO_USER);
    await harness.syncEngine.restore();

    harness.storage.set('beta', 'local-beta-edit');
    harness.syncEngine.markAsPending('beta');
    harness.scheduler.advance(MARK_AS_PENDING_DEBOUNCE_MS + 1);
    await Promise.resolve();
    expect(harness.syncEngine.hasPendingOperations()).toBe(true);

    let releaseMeta!: () => void;
    const metaGate = new Promise<void>((resolve) => {
      releaseMeta = resolve;
    });
    jest.spyOn(harness.metadataManager, 'hydrateMetadata').mockImplementation(() => metaGate);

    const processSpy = jest.spyOn(harness.operationRepo, 'processOperations');
    const hydratePromise = harness.syncEngine.hydrate();
    await Promise.resolve();

    await harness.syncEngine.syncPending();
    expect(processSpy).not.toHaveBeenCalled();

    releaseMeta();
    await hydratePromise;
    harness.scheduler.advance(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(processSpy).toHaveBeenCalled();
  });
});
