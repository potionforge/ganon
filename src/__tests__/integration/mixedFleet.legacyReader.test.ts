/**
 * Mixed-fleet regression guard (step 6.1): new clients must keep legacy remote_metadata
 * current for apps that read only that map.
 */
import MetadataCoordinator from '../../metadata/remote/MetadataCoordinator';
import MetadataStore from '../../metadata/local/MetadataStore';
import FirestoreReferenceManager from '../../firestore/ref/FirestoreReferenceManager';
import FirestoreAdapter from '../../firestore/FirestoreAdapter';
import UserManager from '../../managers/UserManager';
import StorageManager from '../../managers/StorageManager';
import { MMKVFaker } from '../../utils/MMKVFaker';
import { FakeScheduler } from '../utils/FakeScheduler';
import { resolveGanonConfig } from '../../models/config/resolveGanonConfig';
import { REMOTE_METADATA_KEY } from '../../constants';
import { SyncStatus } from '../../models/sync/SyncStatus';
import { TestStorageMapping, MOCK_CLOUD_BACKUP_CONFIG } from '../../__mocks__/MockConfig';

/** Simulates a legacy app install: reads remote_metadata map only. */
function legacyOnlyReader(
  docData: Record<string, unknown>,
  key: string
): { d: string; v: number } | undefined {
  const legacy = (docData[REMOTE_METADATA_KEY] as Record<string, { d: string; v: number }>) || {};
  return legacy[key];
}

describe('mixed-fleet legacy reader (step 6.1)', () => {
  it('flush with default config updates legacy map visible to legacy-only readers', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
    });
    expect(resolved.legacyMetadataWrites).toBe(true);

    const kv = new MMKVFaker();
    const storage = new StorageManager<TestStorageMapping>(kv);
    const mockAdapter = {
      getDocument: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: {} }),
      }),
      setDocument: jest.fn().mockResolvedValue(undefined),
    };
    const mockReferenceManager = {
      getBackupRef: jest.fn().mockReturnValue({ path: 'users/u1/backup' }),
      getDocumentRef: jest.fn().mockReturnValue({ id: 'settings', path: 'users/u1/backup/settings' }),
    };
    const metadataStore = new MetadataStore<TestStorageMapping>(storage);
    const mockUserManager = { isUserLoggedIn: jest.fn().mockReturnValue(true) };

    const scheduler = new FakeScheduler();
    const coordinator = new MetadataCoordinator(
      mockReferenceManager as any,
      mockAdapter as any,
      metadataStore,
      mockUserManager as any,
      'settings',
      resolved,
      scheduler
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

  it('does not write legacy map when legacyMetadataWrites is false (step 6.3)', async () => {
    const resolved = resolveGanonConfig({
      identifierKey: 'email',
      cloudConfig: MOCK_CLOUD_BACKUP_CONFIG,
      legacyMetadataWrites: false,
    });

    const storage = new StorageManager<TestStorageMapping>(new MMKVFaker());
    const mockAdapter = {
      getDocument: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({ [REMOTE_METADATA_KEY]: {} }),
      }),
      setDocument: jest.fn().mockResolvedValue(undefined),
    };
    const mockReferenceManager = {
      getBackupRef: jest.fn().mockReturnValue({ path: 'users/u1/backup' }),
      getDocumentRef: jest.fn().mockReturnValue({ id: 'settings', path: 'users/u1/backup/settings' }),
    };
    const metadataStore = new MetadataStore<TestStorageMapping>(storage);
    const scheduler = new FakeScheduler();

    const coordinator = new MetadataCoordinator(
      mockReferenceManager as any,
      mockAdapter as any,
      metadataStore,
      { isUserLoggedIn: () => true } as any,
      'settings',
      resolved,
      scheduler
    );

    await coordinator.recordLocalChange('settings', {
      digest: 'x',
      version: 1,
      syncStatus: SyncStatus.Pending,
    });
    await coordinator.syncToRemote();

    expect(mockAdapter.setDocument).not.toHaveBeenCalled();
  });
});
