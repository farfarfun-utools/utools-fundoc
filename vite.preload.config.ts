// 把 src/lib/search.ts 单独打成 utools/search-core.cjs，给 preload.js `require`。
//
// 为什么要这么一道：preload.js 是 CommonJS、跑在 Node 侧，没法 import TS 模块；而主搜索框
// 直搜（onMainPush）和应用内的快速打开面板必须用同一套打分逻辑 —— 两边各写一份，排序迟早
// 不一致，用户在主搜索框和插件里搜同一个词得到不同顺序，只会以为是 bug。
//
// 产物是 git 忽略的构建中间物，由 build.sh 生成并断言存在。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // 关掉 publicDir：默认值会把 public/vditor（十几 MB 的离线资源）整个拷进 utools/ 根目录。
  publicDir: false,
  build: {
    outDir: 'utools',
    // 绝对不能清空 outDir —— utools/ 里躺着 plugin.json、preload.js、logo.png 和本脚本的
    // 兄弟 build.sh，清一次等于把插件清单删了。
    emptyOutDir: false,
    // preload 跑在 Electron 的 Node 侧，不需要为浏览器降级。
    target: 'node20',
    // 不压缩：产物只有几 KB，而出问题时要能在 uTools 开发者工具里直接读它。
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/lib/search.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'search-core.cjs',
    },
  },
});
