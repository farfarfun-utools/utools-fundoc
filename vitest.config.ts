import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认的 node 环境够用：被测的是纯数据逻辑，不碰 DOM。
    // 宿主垫片要的 localStorage 由 tests/setup.ts 兜住，省掉一个 jsdom 依赖。
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
