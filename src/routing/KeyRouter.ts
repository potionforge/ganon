import { CloudBackupConfig } from '../models/config/CloudBackupConfig';
import { BaseStorageMapping } from '../models/storage/BaseStorageMapping';

export type KeyOf<T> = Extract<keyof T, string>;

export type RouteResult = {
  document: string;
  kind: 'docField' | 'subcollection';
};

/**
 * Single source of truth for key → Firestore document routing.
 * Built once from cloudConfig at construction; routes are immutable thereafter.
 * cloudConfig is not re-read on route() — callers must rebuild if config changes.
 */
export default class KeyRouter<T extends BaseStorageMapping> {
  private readonly routes = new Map<KeyOf<T>, RouteResult>();

  constructor(cloudConfig: CloudBackupConfig<T>) {
    for (const [documentName, config] of Object.entries(cloudConfig)) {
      if (config.docKeys) {
        for (const key of config.docKeys) {
          this.register(key, { document: documentName, kind: 'docField' });
        }
      }
      if (config.subcollectionKeys) {
        for (const key of config.subcollectionKeys) {
          this.register(key, { document: documentName, kind: 'subcollection' });
        }
      }
    }
  }

  route(key: KeyOf<T>): RouteResult | undefined {
    return this.routes.get(key);
  }

  isCloudKey(key: KeyOf<T>): boolean {
    return this.routes.has(key);
  }

  allCloudKeys(): KeyOf<T>[] {
    return Array.from(this.routes.keys());
  }

  private register(key: KeyOf<T>, route: RouteResult): void {
    const existing = this.routes.get(key);
    if (existing) {
      throw new Error(
        `Ganon: duplicate cloud key "${key}" registered to "${existing.document}" (${existing.kind}) and "${route.document}" (${route.kind})`
      );
    }
    this.routes.set(key, route);
  }
}
