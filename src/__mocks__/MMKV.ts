// Mock MMKV implementation
const MockMMKV = jest.fn().mockImplementation(() => {
  const store = new Map<string, string>();

  return {
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
    }),
    getString: jest.fn().mockImplementation((key: string) => {
      return store.get(key);
    }),
    delete: jest.fn().mockImplementation((key: string) => {
      store.delete(key);
    }),
    clearAll: jest.fn().mockImplementation(() => {
      store.clear();
    }),
    contains: jest.fn().mockImplementation((key: string) => {
      return store.has(key);
    }),
    getAllKeys: jest.fn().mockImplementation(() => {
      return Array.from(store.keys());
    }),
  };
});

// Export both the mock constructor and a default object with MMKV property
export { MockMMKV };
export default { MMKV: MockMMKV };
