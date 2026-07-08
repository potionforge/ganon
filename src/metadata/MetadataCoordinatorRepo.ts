import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import MetadataCoordinator from "./remote/MetadataCoordinator";
import { CloudBackupConfig } from "../models/config/CloudBackupConfig";
import FirestoreAdapter from "../firestore/FirestoreAdapter";
import FirestoreReferenceManager from "../firestore/ref/FirestoreReferenceManager";
import Log from "../utils/Log";
import LocalMetadataManager from "./local/LocalMetadataManager";
import MetadataStore from "./local/MetadataStore";
import UserManager from "../managers/UserManager";
import { Scheduler } from "../ports/Scheduler";
import { ResolvedGanonConfig } from "../models/config/resolveGanonConfig";

export default class MetadataCoordinatorRepo<T extends BaseStorageMapping> {
  private coordinators: Record<string, MetadataCoordinator<T>> = {};

  constructor(
    private cloudConfig: CloudBackupConfig<T>,
    private adapter: FirestoreAdapter<T>,
    private referenceManager: FirestoreReferenceManager<T>,
    private metadataStore: MetadataStore<T>,
    private userManager: UserManager<T>,
    private resolvedConfig: ResolvedGanonConfig<T>,
    private scheduler: Scheduler
  ) {
    this.initialize();
  }

  initialize() {
    Log.verbose('Ganon: MetadataCoordinatorRepo.initialize');
    const documentKeys = Object.keys(this.cloudConfig);

    for (const key of documentKeys) {
      const documentKey = key as Extract<keyof T, string>;
      const coordinator = new MetadataCoordinator(
        this.referenceManager,
        this.adapter,
        this.metadataStore,
        this.userManager,
        documentKey,
        this.resolvedConfig,
        this.scheduler
      );
      this.coordinators[documentKey] = coordinator;
    }
  }

  getCoordinator(documentKey: Extract<keyof T, string>) {
    const coordinator = this.coordinators[documentKey];
    if (!coordinator) {
      Log.warn(`Ganon: MetadataCoordinatorRepo.getCoordinator, no coordinator found for document: ${String(documentKey)}`);
    }
    return coordinator;
  }
}

