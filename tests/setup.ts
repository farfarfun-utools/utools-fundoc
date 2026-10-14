// 给宿主垫片补一个内存版 localStorage。
//
// src/lib/host.ts 在浏览器预览模式下用 localStorage 存数据，Node 里没有这个全局。
// 不引 jsdom 只为这一个 API —— 被测的全是纯数据逻辑，用不上 DOM。

const store = new Map<string, string>();

const memoryStorage: Storage = {
  get length() {
    return store.size;
  },
  key: (index) => [...store.keys()][index] ?? null,
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
};

Object.defineProperty(globalThis, 'localStorage', {
  value: memoryStorage,
  configurable: true,
});

/** 清空垫片存储。用例之间互不干扰，靠它。 */
export function resetStorage(): void {
  store.clear();
}
