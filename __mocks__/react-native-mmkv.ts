// __mocks__/react-native-mmkv.ts
export class MMKV {
  private store = new Map<string, string>();

  set(key: string, value: string) {
    this.store.set(key, value);
  }
  getString(key: string) {
    return this.store.get(key) ?? null;
  }
  delete(key: string) {
    this.store.delete(key);
  }
  clearAll() {
    this.store.clear();
  }
  contains(key: string) {
    return this.store.has(key);
  }
}
