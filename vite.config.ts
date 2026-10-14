import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // uTools 用 file:// 加载 dist/index.html，绝对路径会 404。
  base: './',
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'utools/dist',
    emptyOutDir: true,
    // uTools 8.0 固定跑在 Electron 34 / Chromium 132 上，不用为更老的浏览器降级语法。
    // https://next.u-tools.cn/docs/developer/information/version.html
    target: 'chrome132',
  },
  // Vditor 的 lute / katex / highlight.js 是运行期按 `options.cdn` 拼路径去取的裸文件，
  // 不走 import，所以必须以静态资源原样进产物 —— 它们由 scripts/sync-vditor.mjs 同步到
  // public/vditor/dist/，Vite 会整个目录拷进 dist。千万别试图让打包器去处理它们：
  // KaTeX 的 CSS 和 fonts/ 是按相对路径互相引用的，一旦被 hash 重命名就字形全废。
  publicDir: 'public',
});
