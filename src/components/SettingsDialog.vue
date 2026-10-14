<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDocs } from '../composables/useDocs';
import { MODE_LABELS } from '../composables/useEditor';
import { formatKeys, SHORTCUTS } from '../composables/useShortcuts';
import type { EditorMode, ThemeMode } from '../lib/types';

const emit = defineEmits<{ close: [] }>();

const { state, cleanOrphanAssets } = useDocs();

const MODES: EditorMode[] = ['ir', 'wysiwyg', 'sv'];
const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const cleaning = ref(false);

const stats = computed(() => ({
  docs: state.metas.filter((m) => m.type === 'doc').length,
  dirs: state.metas.filter((m) => m.type === 'dir').length,
  keywords: state.metas.filter((m) => m.keywordEnabled).length,
}));

async function clean(): Promise<void> {
  cleaning.value = true;
  try {
    await cleanOrphanAssets();
  } finally {
    cleaning.value = false;
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-head">设置</div>

      <div class="dialog-body">
        <div class="field">
          <div class="field-label"><span>编辑模式</span></div>
          <select v-model="state.settings.mode" class="select">
            <option v-for="mode in MODES" :key="mode" :value="mode">{{ MODE_LABELS[mode] }}</option>
          </select>
          <p class="field-hint">
            即时渲染是单屏、边写边渲染；分屏预览是左右两栏。切换会重建编辑器。
          </p>
        </div>

        <div class="field">
          <div class="field-label"><span>外观</span></div>
          <select v-model="state.settings.theme" class="select">
            <option v-for="item in THEMES" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
        </div>

        <div class="field">
          <label class="field-label">
            <span>用正文首个标题作为文档名</span>
            <button
              class="switch"
              :class="{ on: state.settings.syncTitleFromHeading }"
              @click="state.settings.syncTitleFromHeading = !state.settings.syncTitleFromHeading"
            />
          </label>
          <p class="field-hint">
            打开后，保存时会把正文里第一个标题同步成左边树上的文档名。
          </p>
        </div>

        <div class="field">
          <div class="field-label">
            <span>自动保存延迟</span>
            <span class="doc-state">{{ state.settings.autoSaveDelay }} ms</span>
          </div>
          <input
            v-model.number="state.settings.autoSaveDelay"
            class="input"
            type="range"
            min="300"
            max="3000"
            step="100"
          />
          <p class="field-hint">
            停止输入这么久后写入数据库。切换文档和退出插件时无论如何都会立刻保存。
          </p>
        </div>

        <div class="field">
          <div class="field-label"><span>数据</span></div>
          <p class="field-hint">
            共 {{ stats.docs }} 篇文档、{{ stats.dirs }} 个目录，{{ stats.keywords }} 篇配了关键词。
            内容存在 uTools 数据库里，开通会员后会自动跨设备同步。
          </p>
          <button class="btn btn-sm" style="margin-top: 8px" :disabled="cleaning" @click="clean">
            {{ cleaning ? '清理中…' : '清理无引用的图片' }}
          </button>
          <p class="field-hint">
            删文档、同步冲突都可能留下没人引用的图片。它们不会自动回收，可以在这里手动清掉。
          </p>
        </div>

        <div class="field">
          <div class="field-label"><span>快捷键</span></div>
          <ul class="keymap">
            <li v-for="item in SHORTCUTS" :key="item.action">
              <span>{{ item.label }}</span>
              <kbd>{{ formatKeys(item.keys) }}</kbd>
            </li>
          </ul>
          <p class="field-hint">
            编辑器内部的加粗、链接、撤销等快捷键由 Vditor 提供，上面这些是整个应用级的。
          </p>
        </div>
      </div>

      <div class="dialog-foot">
        <button class="btn btn-primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>
