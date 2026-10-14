import eslint from '@eslint/js';
import globals from 'globals';
import vue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // search-core.cjs 是 vite 从 src/lib/search.ts 打出来的产物，规则该管的是那份源文件。
  {
    ignores: [
      'utools/dist/**',
      'utools/search-core.cjs',
      'public/vditor/**',
      'node_modules/**',
    ],
  },

  eslint.configs.recommended,
  tseslint.configs.recommended,
  vue.configs['flat/recommended'],

  // 全局规则。放在各个 files 块**之前** —— 扁平配置后面的块覆盖前面的，
  // 放最后会把下面那些针对性的放宽（preload 的 require、构建脚本的 console）全吃掉。
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      // 参数里的 _ 前缀表示「签名需要但用不到」，别报它。
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Vditor 没有发布完整的构造选项类型，边界上还需要 any。
      '@typescript-eslint/no-explicit-any': 'off',
      // 单文件组件的属性顺序不值得为它改一遍模板。
      'vue/attributes-order': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': ['warn', { html: { void: 'any', normal: 'any', component: 'always' } }],
      'eqeqeq': ['warn', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // 渲染进程：浏览器环境，.vue 里的 <script lang="ts"> 要交给 ts parser。
  {
    files: ['src/**/*.{ts,vue}', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, utools: 'readonly' },
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
  },

  // preload 跑在 uTools 的 Node 侧：CommonJS，而且 utools 由宿主注入到全局。
  {
    files: ['utools/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, utools: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // 构建脚本跑在 Node 里。
  {
    files: ['vite.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    // 构建脚本就是靠 stdout 汇报进度的，这里的 console 是功能而不是漏网的调试语句。
    rules: { 'no-console': 'off' },
  },
);
