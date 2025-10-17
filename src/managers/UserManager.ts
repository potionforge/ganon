import IUserManager from "../models/interfaces/IUserManager";
import { BaseStorageMapping } from "../models/storage/BaseStorageMapping";
import Log from "../utils/Log";
import StorageManager from "./StorageManager";

export default class UserManager<T extends BaseStorageMapping> implements IUserManager {
  private currentUser: string | undefined = undefined;

  constructor(
    private identifierKey: Extract<keyof T, string>,
    private storage: StorageManager<T>
  ) {
    this.currentUser = this.storage.get(this.identifierKey) as string | undefined;
  }

  /**
   * Gets the current user identifier
   * @returns The current user identifier or undefined if not set
   */
  getCurrentUser(): string | undefined {
    Log.verbose('Ganon: getCurrentUser');
    return this.currentUser;
  }

  /**
   * Checks if a user is currently logged in
   * @returns True if a user is logged in, false otherwise
   */
  isUserLoggedIn(): boolean {
    Log.verbose(`Ganon: isUserLoggedIn, currentUser: ${this.currentUser}`);
    // Check storage for current value
    this.currentUser = this.storage.get(this.identifierKey) as string | undefined;
    return this.currentUser !== undefined;
  }
}
