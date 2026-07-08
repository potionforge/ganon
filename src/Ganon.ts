import FirestoreManager from "./firestore/FirestoreManager";
import StorageManager from "./managers/StorageManager";
import NetworkMonitor from "./utils/NetworkMonitor";
import { GanonConfig, InternalGanonConfig } from "./models/config/GanonConfig";
import { resolveGanonConfig, ResolvedGanonConfig } from "./models/config/resolveGanonConfig";
import { IntegrityFailureConfig } from "./models/config/IntegrityFailureConfig";
import { IGanon } from "./models/interfaces/IGanon";
import { BaseStorageMapping } from "./models/storage/BaseStorageMapping";
import { BackupResult } from "./models/sync/BackupResult";
import { RestoreResult } from "./models/sync/RestoreResult";
import Log from "./utils/Log";
import SyncError, { SyncErrorType } from "./errors/SyncError";
import SyncEngine from "./sync/SyncEngine";
import DependencyFactory from "./factory/DependencyFactory";
import UserManager from "./managers/UserManager";
import { ConflictResolutionConfig } from "./models/config/ConflictResolutionConfig";
import type {
  GanonEventName,
  GanonEventPayloadMap,
  GanonEventListener,
} from "./models/events/GanonEvents";
import KeyRouter from "./routing/KeyRouter";
import { METADATA_KEY, DIGEST_MAP_KEY, REMOTE_METADATA_KEY } from "./constants";

export default class Ganon<T extends Record<string, any> & BaseStorageMapping> implements IGanon<T> {
  private storageManager: StorageManager<T>;
  private syncEngine: SyncEngine<T>;
  private firestoreManager: FirestoreManager<T>;
  private networkMonitor: NetworkMonitor;
  private static unhandledRejectionHandlerSet = false;
  private userManager: UserManager<T>;
  private keyRouter: KeyRouter<T>;
  private isDestroyed: boolean = false;
  private isInitialized: boolean = false;
  private hydrationWaiters: Array<{ resolve: () => void; cycle: number }> = [];
  private hydrationCycle = 0;
  private hydrationSettled = true;
  private readonly resolvedConfig: ResolvedGanonConfig<T>;

  private readonly _listeners = new Map<
    GanonEventName,
    Set<GanonEventListener<GanonEventName>>
  >();

  constructor(readonly config: GanonConfig<T>) {
    this.resolvedConfig = resolveGanonConfig(config);
    this._validateConfig(config);

    if (config.logLevel !== undefined) {
      Log.setLogLevel(config.logLevel);
    }

    // Internal config with event callbacks; not exposed on public config
    const internalConfig: InternalGanonConfig<T> = {
      ...config,
      eventCallbacks: {
        onHydrationComplete: (result) => {
          if (this.isUserLoggedIn()) {
            this._settleHydrationWaiters();
          }
          this._emit("hydrationComplete", result);
        },
      },
    };

    // Set up global unhandled promise rejection handler (only once)
    if (!Ganon.unhandledRejectionHandlerSet) {
      this._setupGlobalErrorHandlers();
      Ganon.unhandledRejectionHandlerSet = true;
    }

    // Initialize all dependencies through the factory
    try {
      const dependencyFactory = new DependencyFactory<T>(internalConfig);
      const {
        storageManager,
        syncEngine,
        firestoreManager,
        networkMonitor,
        userManager,
        keyRouter,
      } = dependencyFactory.getDependencies();

      this.storageManager = storageManager;
      this.syncEngine = syncEngine;
      this.firestoreManager = firestoreManager;
      this.networkMonitor = networkMonitor;
      this.userManager = userManager;
      this.keyRouter = keyRouter;
      this.isInitialized = true;

      // Load canary so app logs prove this local build is what Metro resolved.
      Log.info('Ganon: build canary — local-main-ticket-B-2026-07-13 (teardown + no-deletes + probe)');

      // Start sync if autoStartSync is enabled and user is logged in
      if (this.resolvedConfig.autoStartSync && this.isUserLoggedIn()) {
        this._beginHydrationCycle();
        this.syncEngine.start();
      }
    } catch (error) {
      Log.error(`Ganon: Failed to initialize components: ${error}`);
      throw new SyncError(
        `Failed to initialize Ganon: ${error}`,
        SyncErrorType.SyncConfigurationError
      );
    }
  }

  /**
   * Checks if a user is currently logged in.
   * @returns True if a user is logged in, false otherwise
   */
  isUserLoggedIn(): boolean {
    return this.userManager.isUserLoggedIn();
  }

  /**
   * Starts the automatic synchronization process with the cloud.
   */
  startSync(): void {
    this.syncEngine.startSyncInterval();
  }

  /**
   * Stops the automatic synchronization process with the cloud.
   */
  stopSync(): void {
    this.syncEngine.stopSyncInterval();
  }

  /**
   * Retrieves a value from storage by its key.
   * @param key - The key to retrieve the value for.
   * @returns The value associated with the key, or undefined if not found.
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.get(key);
  }

  /**
   * Returns the stored value or fallback without persisting the default (I1).
   */
  getOrDefault<K extends keyof T>(key: K, fallback: T[K]): T[K] {
    const value = this.get(key);
    return value !== undefined ? value : fallback;
  }

  /**
   * Resolves when Ganon's hydration settles for the current login cycle.
   * Pending before first login; waiters resolve on logout; fresh pending per new login.
   * Resolves when Ganon's hydration settles — consumer-side post-login merges may not have applied yet.
   */
  whenHydrated(): Promise<void> {
    if (this.isDestroyed) {
      return Promise.reject(
        new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError)
      );
    }
    if (!this.isUserLoggedIn()) {
      return new Promise(resolve => {
        this.hydrationWaiters.push({ resolve, cycle: 0 });
      });
    }
    if (!this._isHydrationPending()) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.hydrationWaiters.push({ resolve, cycle: this.hydrationCycle });
    });
  }

  /**
   * Sets a value in storage for a given key and marks it for synchronization if the key is configured in cloudConfig.
   * @param key - The key to set the value for.
   * @param value - The value to store.
   */
  set<K extends Extract<keyof T, string>>(key: K, value: T[K]): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this._guardEarlyWrite(key);
    this.storageManager.set(key, value);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncEngine.markAsPending(key);
    }
  }

  /**
   * Removes a value from storage by its key and marks it as deleted for synchronization if the key is configured in cloudConfig.
   * @param key - The key of the value to remove.
   */
  remove<K extends Extract<keyof T, string>>(key: K): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this._guardEarlyWrite(key);
    this.storageManager.remove(key);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncEngine.markAsDeleted(key);
    }
  }

  /**
   * Updates an existing value or creates a new one if it doesn't exist, and marks it for synchronization if the key is configured in cloudConfig.
   * @param key - The key to upsert the value for.
   * @param value - The partial value to store. Only the provided fields will be updated.
   */
  upsert<K extends Extract<keyof T, string>>(key: K, value: Partial<T[K]>): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    this._guardEarlyWrite(key);
    this.storageManager.upsert(key, value);
    if (this._shouldSyncKey(key) && this.isUserLoggedIn()) {
      this.syncEngine.markAsPending(key);
    }
  }

  /**
   * Checks if a value exists in storage for a given key.
   * @param key - The key to check.
   * @returns True if the key exists in storage, false otherwise.
   */
  contains<K extends keyof T>(key: K): boolean {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    return this.storageManager.contains(key);
  }

  /**
   * Backup all data to the cloud.
   * @returns The backup result.
   * @throws {SyncError} Throws error if backup operation fails
   */
  async backup(): Promise<BackupResult> {
    Log.info('Ganon: Backing up all data to the cloud');
    try {
      const result = await this.syncEngine.syncAll();
      this._emit("syncComplete", result);
      return result;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error; // Already properly typed error
      }
      throw new SyncError(
        `Backup operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Restore all data from the cloud.
   * @returns The restore result.
   * @throws {SyncError} Throws error if restore operation fails
   */
  async restore(): Promise<RestoreResult> {
    Log.info('Ganon: Restoring all data from the cloud');
    const result = await this.syncEngine.restore();
    this._emit("restoreComplete", result);
    Log.info(`✅ Ganon: Restored ${result.restoredKeys.length} keys`);
    if (result.failedKeys.length > 0) {
      Log.error(`❌ Ganon: Failed to restore ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
    }
    if (result.integrityFailures.length > 0) {
      Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
    }
    return result;
  }

  /**
   * Hydrates specific keys if remote is newer than local.
   * @param keys - Keys to hydrate (optional, defaults to all configured keys)
   * @param conflictConfig - Optional per-invocation conflict resolution configuration
   * @param integrityConfig - Optional per-invocation integrity failure configuration
   */
  async hydrate(keys?: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Hydrating data from the cloud');
    try {
      const result = await this.syncEngine.hydrate(keys, conflictConfig, integrityConfig);
      Log.info(`✅ Ganon: Hydrated ${result.restoredKeys.length} keys`);
      if (result.failedKeys.length > 0) {
        Log.error(`❌ Ganon: Failed to hydrate ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
      }
      if (result.integrityFailures.length > 0) {
        Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
      }
      return result;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Hydration operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Force hydrates specific keys regardless of version comparison.
   * This is useful for debugging and testing when you want to ensure fresh data.
   *
   * @param keys - Array of specific keys to force hydrate
   * @param conflictConfig - Optional per-invocation conflict resolution configuration
   * @param integrityConfig - Optional per-invocation integrity failure configuration.
   *                         If not provided, uses the global configuration from GanonConfig.
   *                         This allows different handling strategies for specific operations
   *                         (e.g., more aggressive retry on first login).
   * @returns The restore result containing information about the hydration operation.
   * @throws {SyncError} Throws error if hydration operation fails
   */
  async forceHydrate(keys: Extract<keyof T, string>[], conflictConfig?: Partial<ConflictResolutionConfig>, integrityConfig?: Partial<IntegrityFailureConfig>): Promise<RestoreResult> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Force hydrating data from the cloud');
    try {
      const result = await this.syncEngine.forceHydrate(keys, conflictConfig, integrityConfig);
      Log.info(`✅ Ganon: Force hydrated ${result.restoredKeys.length} keys`);
      if (result.failedKeys.length > 0) {
        Log.error(`❌ Ganon: Failed to force hydrate ${result.failedKeys.length} keys: ${result.failedKeys.join(', ')}`);
      }
      if (result.integrityFailures.length > 0) {
        Log.warn(`⚠️ Ganon: ${result.integrityFailures.length} keys had integrity failures: ${result.integrityFailures.map(f => f.key).join(', ')}`);
      }
      return result;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Force hydration operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Dangerously delete all data from the cloud.
   * WARNING: This operation cannot be undone!
   * @returns Promise that resolves when the operation is complete
   * @throws {SyncError} Throws error if delete operation fails
   */
  async dangerouslyDelete(): Promise<void> {
    Log.info('Ganon: Dangerously deleting all data from the cloud');
    try {
      return await this.firestoreManager.dangerouslyDelete();
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError(
        `Dangerous delete operation failed: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Clear all data from the local storage.
   * @returns void
   */
  clearAllData(): void {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    Log.info('Ganon: Clearing all data from local storage');
    try {
      this.storageManager.clearAllData();
    } catch (error) {
      Log.error(`Ganon: Failed to clear local data: ${error}`);
      throw new SyncError(
        `Failed to clear local data: ${error}`,
        SyncErrorType.SyncFailed
      );
    }
  }

  /**
   * Sets the log level for Ganon operations.
   * @param logLevel - The log level to set
   */
  setLogLevel(logLevel: number): void {
    Log.setLogLevel(logLevel);
  }

  /**
   * Handles user login lifecycle with smart restore/backup decisions.
   * - If the same user is already set locally (app reopen), it is a no-op.
   * - If this is a new login and remote has data, restores from remote.
   * - If this is a new login and remote has no data, backs up local guest state.
   * Returns the action performed: "noop", "restore" or "backup".
   */
  async login(userId: string): Promise<"noop" | "restore" | "backup"> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    const current = this.userManager.getCurrentUser() || this.storageManager.get(this.config.identifierKey) as unknown as string | undefined;

    if (current === userId) {
      Log.info('Ganon: login called with same user; treating as app reopen (noop)');
      return "noop";
    }

    this._beginHydrationCycle();

    try {
      // Set identifier locally to mark user as logged in
      this.storageManager.set(this.config.identifierKey as Extract<keyof T, string>, userId as unknown as T[Extract<keyof T, string>]);

      // Decide whether remote has data. Indeterminate must NOT choose backup —
      // that arm runs syncAll with writes; errors-as-empty was the incident trigger.
      const probe = await this.syncEngine.probeRemoteData();

      let result: "restore" | "backup";
      if (probe.status === 'present') {
        Log.info('Ganon: Existing remote data detected on login - restoring');
        await this.restore();
        result = "restore";
      } else if (probe.status === 'indeterminate') {
        Log.warn(
          `Ganon: Remote probe indeterminate on login (${probe.reason}); refusing backup, attempting restore`
        );
        await this.restore();
        result = "restore";
      } else {
        Log.info('Ganon: No remote data detected on login - backing up local guest state');
        await this.backup();
        result = "backup";
      }

      if (this.resolvedConfig.autoStartSync) {
        this.syncEngine.start();
      } else {
        this._settleHydrationWaiters();
      }

      return result;
    } catch (error) {
      this._settleHydrationWaiters();
      throw error;
    }
  }

  /**
   * Handles user logout lifecycle.
   * By default, performs a backup before logging out. You can skip backup with options.backup = false.
   */
  async logout(options?: { backup?: boolean }): Promise<void> {
    if (this.isDestroyed) {
      throw new SyncError('Cannot perform operation: Ganon instance has been destroyed', SyncErrorType.SyncConfigurationError);
    }

    const doBackup = options?.backup !== false;

    try {
      if (doBackup && this.isUserLoggedIn()) {
        Log.info('Ganon: Performing backup on logout');
        await this.backup();
      }
    } finally {
      // Stop sync and cancel pending operations
      this.stopSync();
      this.syncEngine.cancelPendingOperations();
      this._resetHydrationCycle();

      // Clear all data
      this.clearAllData();
    }
  }

  /**
   * Cleans up all resources used by Ganon.
   * This includes stopping sync, destroying the sync controller, and cleaning up the network monitor.
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    Log.info('Ganon: Destroying instance');
    try {
      // Stop sync if it's running
      this.stopSync();

      // Clean up components if they exist
      if (this.syncEngine) {
        this.syncEngine.destroy();
      }
      if (this.networkMonitor) {
        this.networkMonitor.destroy();
      }

      this._listeners.clear();

      // Mark as destroyed
      this.isDestroyed = true;
    } catch (error) {
      Log.error(`Ganon: Error during cleanup: ${error}`);
      // Still mark as destroyed even if cleanup fails
      this.isDestroyed = true;
    }
  }

  /**
   * Subscribe to a Ganon event. Use this to react to hydration, sync, or restore completion
   * (e.g. update root app state when automatic hydration finishes and any keys were restored).
   *
   * @param event - Event name: `hydrationComplete` | `syncComplete` | `restoreComplete`
   * @param listener - Callback receiving the event payload
   */
  on<N extends GanonEventName>(
    event: N,
    listener: GanonEventListener<N>
  ): void {
    if (this.isDestroyed) return;
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener as GanonEventListener<GanonEventName>);
  }

  /**
   * Unsubscribe a previously added listener.
   */
  off<N extends GanonEventName>(
    event: N,
    listener: GanonEventListener<N>
  ): void {
    const set = this._listeners.get(event);
    if (set) set.delete(listener as GanonEventListener<GanonEventName>);
  }

  /**
   * Subscribe to a Ganon event once; the listener is removed after the first invocation.
   */
  once<N extends GanonEventName>(
    event: N,
    listener: GanonEventListener<N>
  ): void {
    const wrapped: GanonEventListener<N> = (payload) => {
      this.off(event, wrapped);
      listener(payload);
    };
    this.on(event, wrapped);
  }

  /* P R I V A T E */

  /** Shared by whenHydrated() and earlyWriteGuard — one definition of hydration-pending. */
  private _isHydrationPending(): boolean {
    return this.isUserLoggedIn() && !this.hydrationSettled;
  }

  private _beginHydrationCycle(): void {
    this.hydrationCycle += 1;
    this.hydrationSettled = false;
  }

  private _settleHydrationWaiters(): void {
    this.hydrationSettled = true;
    const cycle = this.hydrationCycle;
    const waiters = this.hydrationWaiters.filter(w => w.cycle === cycle || w.cycle === 0);
    this.hydrationWaiters = this.hydrationWaiters.filter(w => w.cycle !== cycle && w.cycle !== 0);
    waiters.forEach(w => w.resolve());
  }

  /** Resolve pending waiters on logout so promises never dangle across sessions. */
  private _resolveHydrationWaitersOnLogout(): void {
    const waiters = [...this.hydrationWaiters];
    this.hydrationWaiters = [];
    waiters.forEach(w => w.resolve());
  }

  private _resetHydrationCycle(): void {
    this._resolveHydrationWaitersOnLogout();
    this.hydrationCycle += 1;
    this.hydrationSettled = true;
  }

  private _guardEarlyWrite(key: Extract<keyof T, string>): void {
    const guard = this.config.earlyWriteGuard ?? 'off';
    if (guard === 'off' || !this._shouldSyncKey(key)) {
      return;
    }
    if (!this._isHydrationPending()) {
      return;
    }
    const message = `Write to "${String(key)}" while hydration is in progress`;
    if (guard === 'throw') {
      throw new SyncError(message, SyncErrorType.SyncValidationError);
    }
    Log.warn(`Ganon: ${message}`);
  }

  /**
   * Checks if a key is configured for cloud synchronization
   * @param key - The key to check
   * @returns True if the key should be synced to the cloud
   */
  private _shouldSyncKey<K extends Extract<keyof T, string>>(key: K): boolean {
    if (!this.isInitialized || this.isDestroyed) {
      return false;
    }
    return this.keyRouter.isCloudKey(key);
  }

  /**
   * Sets up global error handlers to prevent app crashes from unhandled promise rejections.
   * This is called once per Ganon instance lifecycle.
   * @private
   */
  private _setupGlobalErrorHandlers(): void {
    // Only set up in React Native environment (not in Node.js test environment)
    if (typeof global !== 'undefined' && (global as any).ErrorUtils) {
      const originalHandler = (global as any).ErrorUtils.getGlobalHandler();

      (global as any).ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
        // Log the error through Ganon's logging system
        Log.error(`Ganon: Unhandled error caught: ${error.message}`);

        // Call the original handler if it exists
        if (originalHandler) {
          originalHandler(error, isFatal);
        }
      });
    }

    // Set up unhandled promise rejection handler
    if (typeof process !== 'undefined' && process.on) {
      process.on('unhandledRejection', (reason: any) => {
        Log.error(`Ganon: Unhandled promise rejection: ${reason}`);
        // Don't re-throw to prevent crash
      });
    }
  }

  private _emit<N extends GanonEventName>(
    event: N,
    payload: GanonEventPayloadMap[N]
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    set.forEach((listener) => {
      try {
        listener(payload);
      } catch (err) {
        Log.error(`Ganon: event listener error (${event}): ${err}`);
      }
    });
  }

  private _validateConfig(config: GanonConfig<T>): void {
    if (!config) {
      throw new SyncError(
        'Ganon configuration is required',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate identifierKey
    if (!config.identifierKey || config.identifierKey.trim() === '') {
      throw new SyncError(
        'Ganon: identifierKey is required in config and cannot be empty',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate cloudConfig
    if (!config.cloudConfig) {
      throw new SyncError(
        'Ganon: cloudConfig is required in config',
        SyncErrorType.SyncConfigurationError
      );
    }

    // Validate optional config properties
    if (config.syncInterval !== undefined && (typeof config.syncInterval !== 'number' || config.syncInterval < 0)) {
      throw new SyncError(
        'Ganon: syncInterval must be a positive number if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (config.autoStartSync !== undefined && typeof config.autoStartSync !== 'boolean') {
      throw new SyncError(
        'Ganon: autoStartSync must be a boolean if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    if (config.logLevel !== undefined && (typeof config.logLevel !== 'number' || config.logLevel < 0)) {
      throw new SyncError(
        'Ganon: logLevel must be a positive number if provided',
        SyncErrorType.SyncConfigurationError
      );
    }

    const cloudConfigEntries = Object.entries(config.cloudConfig);
    if (cloudConfigEntries.length === 0) {
      throw new SyncError(
        'Ganon: cloudConfig must contain at least one document configuration',
        SyncErrorType.SyncConfigurationError
      );
    }

    const allKeysInAllDocs = new Set<string>();
    const validDocNameRegex = /^[a-zA-Z0-9_-]+$/;

    for (const [docName, docConfig] of cloudConfigEntries) {
      // Validate document name
      if (!docName || !validDocNameRegex.test(docName)) {
        throw new SyncError(
          `Ganon: Document name "${docName}" is invalid. Document names must contain only letters, numbers, underscores, and hyphens.`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (!docConfig) {
        throw new SyncError(
          `Ganon: Document configuration for "${docName}" cannot be null or undefined`,
          SyncErrorType.SyncConfigurationError
        );
      }

      // Validate docKeys and subcollectionKeys types
      if (docConfig.docKeys && !Array.isArray(docConfig.docKeys)) {
        throw new SyncError(
          `Ganon: docKeys for document "${docName}" must be an array`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (docConfig.subcollectionKeys && !Array.isArray(docConfig.subcollectionKeys)) {
        throw new SyncError(
          `Ganon: subcollectionKeys for document "${docName}" must be an array`,
          SyncErrorType.SyncConfigurationError
        );
      }

      if (!docConfig.docKeys?.length && !docConfig.subcollectionKeys?.length) {
        throw new SyncError(
          `Ganon: Document "${docName}" must have either docKeys or subcollectionKeys defined`,
          SyncErrorType.SyncConfigurationError
        );
      }

      const allKeysInDoc = [...(docConfig.docKeys || []), ...(docConfig.subcollectionKeys || [])];
      const validKeyRegex = /^[a-zA-Z0-9_\-:]+$/;

      for (const key of allKeysInDoc) {
        // Validate key type
        if (typeof key !== 'string') {
          throw new SyncError(
            `Ganon: Key in document "${docName}" must be a string`,
            SyncErrorType.SyncConfigurationError
          );
        }

        // Validate key format
        if (!key || key.trim() === '') {
          throw new SyncError(
            `Ganon: Invalid key found in document "${docName}". Keys cannot be empty`,
            SyncErrorType.SyncConfigurationError
          );
        }

        if (!validKeyRegex.test(key)) {
          throw new SyncError(
            `Ganon: Key "${key}" in document "${docName}" is invalid. Keys must contain only letters, numbers, underscores, and hyphens.`,
            SyncErrorType.SyncConfigurationError
          );
        }

        if (key === METADATA_KEY) {
          throw new SyncError(
            `Ganon: Key "${key}" in document "${docName}" collides with reserved metadata namespace`,
            SyncErrorType.SyncConfigurationError
          );
        }

        if (key === DIGEST_MAP_KEY) {
          throw new SyncError(
            `Ganon: Key "${key}" in document "${docName}" collides with reserved in-document digest namespace`,
            SyncErrorType.SyncConfigurationError
          );
        }

        if (key === REMOTE_METADATA_KEY) {
          throw new SyncError(
            `Ganon: Key "${key}" in document "${docName}" collides with reserved legacy remote metadata namespace`,
            SyncErrorType.SyncConfigurationError
          );
        }

        // Check for duplicates
        if (allKeysInAllDocs.has(key)) {
          throw new SyncError(
            `Ganon: Duplicate key "${key}" found in document "${docName}". Keys must be unique across all documents.`,
            SyncErrorType.SyncConfigurationError
          );
        }
        allKeysInAllDocs.add(key);
      }
    }
  }
}
