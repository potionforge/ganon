type Listener = (key: string) => void;

/**
 * A fake MMKV implementation for testing purposes due to issues with
 * MMKV only being able to be used with synchronous method invocations (JSI).
 *
 * JSI is basically a way to call native code from JavaScript in React Native.
 *
 * https://stackoverflow.com/questions/78561407/i-have-a-bug-on-rn-0-74
 */

export class MMKVFaker {
  private data: { [key: string]: string | undefined } = {};
  private listeners: Listener[] = [];

  getString(key: string): string | undefined {
    return this.data[key];
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.notifyListeners(key);
  }

  delete(key: string): void {
    delete this.data[key];
    this.notifyListeners(key);
  }

  clearAll(): void {
    this.data = {};
    Object.keys(this.data).forEach(key => this.notifyListeners(key));
  }

  addOnValueChangedListener(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    }
  }

  contains(key: string): boolean {
    return this.data.hasOwnProperty(key);
  }

  private notifyListeners(key: string): void {
    this.listeners.forEach(listener => listener(key));
  }
}
