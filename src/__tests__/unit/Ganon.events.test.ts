import { jest } from '@jest/globals';
import Ganon from '../../Ganon';
import { GanonConfig } from '../../models/config/GanonConfig';
import { BaseStorageMapping } from '../../models/storage/BaseStorageMapping';

/** Captured internal config passed to DependencyFactory by Ganon (used to trigger hydrationComplete in tests). */
let capturedInternalConfig: { eventCallbacks?: { onHydrationComplete?: (r: any) => void } } | undefined;

jest.mock('../../factory/DependencyFactory', () => {
  return jest.fn().mockImplementation((cfg: any) => {
    capturedInternalConfig = cfg;
    return { getDependencies: () => mockDeps };
  });
});

interface TestStorage extends BaseStorageMapping {
  email: string;
  key1: string;
}

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
  destroy: jest.fn(),
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

const backupResult = {
  success: true,
  backedUpKeys: ['key1'],
  failedKeys: [],
  skippedKeys: [],
  timestamp: new Date(),
};

const restoreResult = {
  success: true,
  restoredKeys: ['key1'],
  failedKeys: [],
  integrityFailures: [],
  timestamp: new Date(),
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

describe('Ganon events API', () => {
  let ganon: Ganon<TestStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserManager.getCurrentUser.mockReturnValue(undefined);
    mockUserManager.isUserLoggedIn.mockReturnValue(false);
    mockStorageManager.get.mockReturnValue(undefined);
    mockSyncController.syncAll.mockResolvedValue(backupResult);
    mockSyncController.restore.mockResolvedValue(restoreResult);
    ganon = new Ganon<TestStorage>(config);
  });

  describe('on / emit', () => {
    it('emits syncComplete when backup() completes', async () => {
      const listener = jest.fn();
      ganon.on('syncComplete', listener);
      await ganon.backup();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(backupResult);
    });

    it('emits restoreComplete when restore() completes', async () => {
      const listener = jest.fn();
      ganon.on('restoreComplete', listener);
      await ganon.restore();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(restoreResult);
    });

    it('emits hydrationComplete when internal callback is invoked', () => {
      const listener = jest.fn();
      ganon.on('hydrationComplete', listener);
      expect(capturedInternalConfig?.eventCallbacks?.onHydrationComplete).toBeDefined();
      capturedInternalConfig!.eventCallbacks!.onHydrationComplete!(restoreResult);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(restoreResult);
    });

    it('calls multiple listeners for the same event', async () => {
      const a = jest.fn();
      const b = jest.fn();
      ganon.on('syncComplete', a);
      ganon.on('syncComplete', b);
      await ganon.backup();
      expect(a).toHaveBeenCalledWith(backupResult);
      expect(b).toHaveBeenCalledWith(backupResult);
    });
  });

  describe('off', () => {
    it('removes listener so it is not called on next emit', async () => {
      const listener = jest.fn();
      ganon.on('syncComplete', listener);
      ganon.off('syncComplete', listener);
      await ganon.backup();
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not remove other listeners for the same event', async () => {
      const removed = jest.fn();
      const kept = jest.fn();
      ganon.on('syncComplete', removed);
      ganon.on('syncComplete', kept);
      ganon.off('syncComplete', removed);
      await ganon.backup();
      expect(removed).not.toHaveBeenCalled();
      expect(kept).toHaveBeenCalledWith(backupResult);
    });
  });

  describe('once', () => {
    it('calls listener only once then removes it', async () => {
      const listener = jest.fn();
      ganon.once('syncComplete', listener);
      await ganon.backup();
      await ganon.backup();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(backupResult);
    });
  });

  describe('destroy', () => {
    it('clears listeners so callback does not invoke them', () => {
      const listener = jest.fn();
      ganon.on('hydrationComplete', listener);
      ganon.destroy();
      capturedInternalConfig!.eventCallbacks!.onHydrationComplete!(restoreResult);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
