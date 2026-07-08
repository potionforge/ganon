/**
 * Mixed-fleet regression guard (step 6.1): new clients must keep legacy remote_metadata
 * current for apps that read only that map, and dual-read must route through hydration wiring.
 */
jest.mock('@react-native-firebase/firestore');
jest.mock('../../utils/Log', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}));

import MetadataCoordinator from '../../metadata/remote/MetadataCoordinator';
import MetadataStore from '../../metadata/local/MetadataStore';
import StorageManager from '../../managers/StorageManager';
import UserManager from '../../managers/UserManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeScheduler } from '../utils/FakeScheduler';
import { FakeFirestore } from '../utils/FakeFirestore';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { REMOTE_METADATA_KEY } from '../../constants';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';
import { DIGEST_MAP_KEY } from '../../constants';

const USER_DOC_PATH = 'users/user-1/backup/user';

/** Simulates a legacy app install: reads remote_metadata map only. */
function legacyOnlyReader(
  docData: Record<string, unknown>,
  key: string
): { d: string; v: number } | undefined {
  const legacy = (docData[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>) || {};
  return legacy[key];
}

async function drainScheduledFlush(scheduler: FakeScheduler, debounceMs: number): Promise<void> {
  scheduler.advance(debounceMs + 1);
  await new Promise<void>(resolve => setImmediate(resolve));
}

function createMockCoordinatorHarness(
  resolved: ReturnType<typeof resolveGanonConfig<TestStorageMapping>>,
  scheduler: FakeScheduler,
  getDocumentData: () => Record<string, unknown>
) {
  const storage = new StorageManager<TestStorageMapping>(new MMKVFaker());
  const mockAdapter = {
    getDocument: jest.fn().mockResolvedValue({
      exists: true,
      data: getDocumentData,
    }),
    setDocument: jest.fn().mockResolvedValue(undefined),
  };
  const mockReferenceManager = {
    getBackupRef: jest.fn().mockReturnValue({ path: 'users/u1/backup' }),
    getDocumentRef: jest.fn().mockReturnValue({ id: 'user', path: USER_DOC_PATH }),
  };
  const metadataStore = new MetadataStore<TestStorageMapping>(storage);

  const coordinator = new MetadataCoordinator(
    mockReferenceManager as any,
    mockAdapter as any,
    metadataStore,
    { isUserLoggedIn: () => true } as any,
    'user',
    resolved,
    scheduler
  );

  return { coordinator, metadataStore, mockAdapter };
}

function createFakeFirestoreCoordinatorHarness(
  resolved: ReturnType<typeof resolveGanonConfig<TestStorageMapping>>,
  scheduler: FakeScheduler,
  seedDoc: Record<string, unknown> = {}
) {
  const fake = new FakeFirestore();
  if (Object.keys(seedDoc).length > 0) {
    fake.setDocument(USER_DOC_PATH, seedDoc);
  }

  const kv = new MMKVFaker();
  const storage = new StorageManager<TestStorageMapping>(kv);
  storage.set('email', 'user-1');
  const userManager = new UserManager<TestStorageMapping>('email', storage);
  const ganonConfig = {
    identifierKey: 'email' as const,
    cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
  };
  const adapter = new FirestoreAdapter<TestStorageMapping>(ganonConfig, fake.module);
  // Signature: (userManager, cloudConfig, firestoreModule?) — KeyRouter is internal.
  const referenceManager = new FirestoreReferenceManager<TestStorageMapping>(
    userManager,
    MOCK_CLOUD_BACKUP_CONFIG,
    fake.module
  );
  const metadataStore = new MetadataStore<TestStorageMapping>(storage);
  const setDocumentSpy = jest.spyOn(adapter, 'setDocument');

  const coordinator = new MetadataCoordinator(
    referenceManager,
    adapter,
    metadataStore,
    userManager,
    'user',
    resolved,
    scheduler
  );

  const userDocRef = referenceManager.getDocumentRefForKey('count');

  return { coordinator, metadataStore, fake, adapter, setDocumentSpy, userDocRef };
}

describe('mixed-fleet legacy reader (step 6.1)', () => {
  it('flush with default config updates legacy map visible to legacy-only readers', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    expect(resolved.legacyMetadataWrites).toBe(true);

    const { coordinator, mockAdapter } = createMockCoordinatorHarness(
      resolved,
      new FakeScheduler(),
      () => ({ [REMOTE_METADATA_KEY]: {} })
    );

    const key = 'settings' as keyof TestStorageMapping;
    await coordinator.recordLocalChange(key, {
      digest: 'fleet-digest',
      version: 7,
      syncStatus: SyncStatus.Pending,
    });

    await coordinator.syncToRemote();

    expect(mockAdapter.setDocument).toHaveBeenCalled();
    const flushPayload = mockAdapter.setDocument.mock.calls[0][1] as Record<string, unknown>;
    const legacyMap = flushPayload[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;

    const legacyView = legacyOnlyReader({ [REMOTE_METADATA_KEY]: legacyMap }, String(key));
    expect(legacyView).toEqual({ d: 'fleet-digest', v: 7 });
  });

  it('debounced flush with legacyMetadataWrites true calls setDocument after scheduler drain', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    const scheduler = new FakeScheduler();
    const { coordinator, mockAdapter } = createMockCoordinatorHarness(
      resolved,
      scheduler,
      () => ({ [REMOTE_METADATA_KEY]: {} })
    );

    await coordinator.recordLocalChange('settings', {
      digest: 'debounced-digest',
      version: 3,
      syncStatus: SyncStatus.Pending,
    });

    await drainScheduledFlush(scheduler, resolved.metadataFlushDebounceMs);

    expect(mockAdapter.setDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        [REMOTE_METADATA_KEY]: expect.objectContaining({
          settings: { d: 'debounced-digest', v: 3 },
        }),
      }),
      { merge: true }
    );
  });

  it('flush writes only changed keys; merge preserves unrelated legacy entries (FakeFirestore)', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    const existingSettings = { d: 'existing-settings', v: 99 };

    const { coordinator, fake, setDocumentSpy } = createFakeFirestoreCoordinatorHarness(
      resolved,
      new FakeScheduler(),
      {
        [REMOTE_METADATA_KEY]: {
          settings: existingSettings,
        },
      }
    );

    await coordinator.recordLocalChange('count', {
      digest: 'count-digest',
      version: 8,
      syncStatus: SyncStatus.Pending,
    });
    await coordinator.syncToRemote();

    const flushPayload = setDocumentSpy.mock.calls.at(-1)![1] as Record<string, unknown>;
    const legacyMap = flushPayload[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;

    expect(legacyMap.count).toEqual({ d: 'count-digest', v: 8 });
    expect(legacyMap.settings).toBeUndefined();

    const finalDoc = fake.getDocument(USER_DOC_PATH)!;
    expect(finalDoc[REMOTE_METADATA_KEY]).toEqual({
      settings: existingSettings,
      count: { d: 'count-digest', v: 8 },
    });
  });

  it('does not regress concurrent legacy-map updates from stale cache (no cache spread)', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    const staleSettings = { d: 'stale-settings', v: 99 };
    const concurrentSettings = { d: 'concurrent-settings', v: 100 };

    const { coordinator, fake, setDocumentSpy, adapter, userDocRef } =
      createFakeFirestoreCoordinatorHarness(resolved, new FakeScheduler(), {
        [REMOTE_METADATA_KEY]: { settings: staleSettings },
      });

    await coordinator.getRemoteMetadata();

    await adapter.setDocument(
      userDocRef,
      { [REMOTE_METADATA_KEY]: { settings: concurrentSettings } },
      { merge: true }
    );

    await coordinator.recordLocalChange('count', {
      digest: 'count-digest',
      version: 8,
      syncStatus: SyncStatus.Pending,
    });
    await coordinator.syncToRemote();

    const flushPayload = setDocumentSpy.mock.calls.at(-1)![1] as Record<string, unknown>;
    const legacyMap = flushPayload[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>;

    // Payload absence is the regression guard: pre-flush fetch refreshes the cache to v100,
    // so final-doc state alone would not catch a reintroduced cache spread (it would re-assert fresh v100).
    expect(legacyMap).toEqual({ count: { d: 'count-digest', v: 8 } });
    expect(legacyMap.settings).toBeUndefined();

    const finalDoc = fake.getDocument(USER_DOC_PATH)!;
    expect((finalDoc[REMOTE_METADATA_KEY] as Record<string, unknown>).settings).toEqual(
      concurrentSettings
    );
    expect((finalDoc[REMOTE_METADATA_KEY] as Record<string, unknown>).count).toEqual({
      d: 'count-digest',
      v: 8,
    });
  });

  it('dual-mode hydration treats legacy digest as remote truth when old client wrote higher version', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    expect(resolved.digestReadMode).toBe('dual');

    const docAfterOldClientUpdate = {
      [DIGEST_MAP_KEY]: {
        settings: { d: 'new-client-digest', v: 5 },
      },
      [REMOTE_METADATA_KEY]: {
        settings: { d: 'old-client-digest', v: 10 },
      },
    };

    const { coordinator, metadataStore } = createMockCoordinatorHarness(
      resolved,
      new FakeScheduler(),
      () => docAfterOldClientUpdate
    );

    metadataStore.recordSyncedState('settings', {
      digest: 'local-digest',
      version: 5,
      syncStatus: SyncStatus.Synced,
    });

    expect(await coordinator.needsHydration('settings')).toBe(true);

    const remote = await coordinator.getRemoteMetadata(['settings']);
    expect(remote.settings).toEqual({ d: 'old-client-digest', v: 10 });
    expect(legacyOnlyReader(docAfterOldClientUpdate, 'settings')).toEqual({
      d: 'old-client-digest',
      v: 10,
    });
  });

  it('does not write legacy map when legacyMetadataWrites is false (step 6.3)', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
      legacyMetadataWrites: false,
    });

    const scheduler = new FakeScheduler();
    const { coordinator, mockAdapter } = createMockCoordinatorHarness(
      resolved,
      scheduler,
      () => ({ [REMOTE_METADATA_KEY]: {} })
    );

    await coordinator.recordLocalChange('settings', {
      digest: 'x',
      version: 1,
      syncStatus: SyncStatus.Pending,
    });

    await drainScheduledFlush(scheduler, resolved.metadataFlushDebounceMs);
    expect(mockAdapter.setDocument).not.toHaveBeenCalled();

    await coordinator.syncToRemote();
    await drainScheduledFlush(scheduler, resolved.metadataFlushDebounceMs);
    expect(mockAdapter.setDocument).not.toHaveBeenCalled();
  });
});
