import Log from './Log';

export default class NetworkMonitor {
  private _listeners: ((isOnline: boolean) => void)[] = [];
  private _isDestroyed: boolean = false;

  constructor() {
    // Always start as online
    this.broadcast(true);
  }

  broadcast(isOnline: boolean) {
    if (this._isDestroyed) return;

    try {
      this._listeners.forEach((listener) => listener(isOnline));
    } catch (error) {
      Log.error(`NetworkMonitor: Error broadcasting network state: ${error}`);
    }
  }

  isOnline() {
    return true; // Always return true
  }

  onNetworkChange(listener: (isOnline: boolean) => void) {
    if (this._isDestroyed) return;
    this._listeners.push(listener);
    // Immediately notify the new listener of current state
    listener(true);
  }

  destroy() {
    this._isDestroyed = true;
    this._listeners = [];
  }
}
