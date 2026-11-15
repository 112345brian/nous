// Jest manual mock — an in-memory expo-secure-store with test controls.
let store = new Map();
let available = true;
let failSet = false;
let failGet = false;

module.exports = {
  __esModule: true,
  isAvailableAsync: async () => available,
  getItemAsync: async (key) => {
    if (failGet) throw new Error('mock: getItemAsync failed');
    return store.has(key) ? store.get(key) : null;
  },
  setItemAsync: async (key, value) => {
    if (failSet) throw new Error('mock: setItemAsync failed');
    store.set(key, value);
  },
  deleteItemAsync: async (key) => { store.delete(key); },

  // Test controls (not part of the real API).
  __reset: () => { store = new Map(); available = true; failSet = false; failGet = false; },
  __setAvailable: (v) => { available = v; },
  __setFailSet: (v) => { failSet = v; },
  __setFailGet: (v) => { failGet = v; },
  __dump: () => Object.fromEntries(store),
};
