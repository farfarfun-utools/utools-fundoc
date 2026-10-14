<script setup lang="ts">
// 左栏：多层目录文件系统。
//
// 树被**拍平成可见行列表**再渲染，而不是用递归组件。理由是拖拽：落点要在
// 「插到某行之前 / 之后 / 放进某个目录里」三者间判定，一维列表上算起来干净得多，
// 递归组件还得层层转发 drag 事件。
import { computed, nextTick, ref } from 'vue';
import Icon from './Icon.vue';
import { useDocs } from '../composables/useDocs';
import { useSearch } from '../composables/useSearch';
import { siblingsOf } from '../lib/tree';
import type { NodeType, TreeNode } from '../lib/types';

const emit = defineEmits<{ keyword: [nodeId: string] }>();

const {
  state,
  tree,
  createNode,
  renameNode,
  moveNode,
  deleteNode,
  openNode,
  toggleExpanded,
  exportNode,
} = useDocs();
const { openPalette } = useSearch();

type Row = { node: TreeNode; depth: number };

/** 只渲染展开路径上的节点 —— 几千篇文档时不至于一次画出全部行。 */
const rows = computed<Row[]>(() => {
  const result: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      result.push({ node, depth });
      if (node.type === 'dir' && state.expanded.includes(node.nodeId)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree.value.roots, 0);
  return result;
});

// ── 重命名 ──
const renamingId = ref<string | null>(null);
const renameText = ref('');

async function startRename(node: TreeNode): Promise<void> {
  renamingId.value = node.nodeId;
  renameText.value = node.name;
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('.tree-rename');
  input?.select();
}

function commitRename(): void {
  if (!renamingId.value) return;
  renameNode(renamingId.value, renameText.value);
  renamingId.value = null;
}

// ── 右键菜单 ──
type Menu = { x: number; y: number; node: TreeNode | null };
const menu = ref<Menu | null>(null);

function openMenu(event: MouseEvent, node: TreeNode | null): void {
  // 菜单宽 152、最多 6 项加两条分隔线约 200 高，靠近右/下边缘时往回收，别画到窗口外面。
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 164),
    y: Math.min(event.clientY, window.innerHeight - 210),
    node,
  };
}

async function menuCreate(type: NodeType): Promise<void> {
  const node = menu.value?.node ?? null;
  // 在目录上右键 → 建在它里面；在文档上右键 → 建成它的同级。
  const parentId = node ? (node.type === 'dir' ? node.nodeId : node.parentId) : null;
  menu.value = null;
  const created = await createNode(type, parentId);
  if (!created) return;
  const meta = state.metas.find((m) => m.nodeId === created);
  if (meta) await startRename({ ...meta, children: [], depth: 0 });
}

async function menuExport(): Promise<void> {
  const node = menu.value?.node ?? null;
  menu.value = null;
  // 在空白处右键 → node 为 null → 导出整个库。
  await exportNode(node?.nodeId ?? null);
}

async function menuDelete(): Promise<void> {
  const node = menu.value?.node;
  menu.value = null;
  if (!node) return;
  const extra = node.type === 'dir' ? '及其中全部内容' : '';
  if (!window.confirm(`确定删除「${node.name}」${extra}？此操作不可撤销。`)) return;
  await deleteNode(node.nodeId);
}

// ── 拖拽 ──
type Zone = 'before' | 'after' | 'inside';
const dragId = ref<string | null>(null);
const dropTarget = ref<{ nodeId: string | null; zone: Zone } | null>(null);

/** 按光标在行内的纵向位置判定落点。目录中间 50% 是「放进去」，文档没有这一档。 */
function zoneAt(event: DragEvent, node: TreeNode): Zone {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (node.type !== 'dir') return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}

function onDragOver(event: DragEvent, node: TreeNode): void {
  if (!dragId.value || dragId.value === node.nodeId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTarget.value = { nodeId: node.nodeId, zone: zoneAt(event, node) };
}

function onDrop(event: DragEvent, node: TreeNode): void {
  event.preventDefault();
  event.stopPropagation();
  const source = dragId.value;
  const target = dropTarget.value;
  dragId.value = null;
  dropTarget.value = null;
  if (!source || !target || source === node.nodeId) return;

  if (target.zone === 'inside') {
    moveNode(source, node.nodeId, null);
    if (!state.expanded.includes(node.nodeId)) toggleExpanded(node.nodeId);
    return;
  }

  const siblings = siblingsOf(state.metas, node.parentId).filter((m) => m.nodeId !== source);
  const index = siblings.findIndex((m) => m.nodeId === node.nodeId);
  // 放到某行之后 == 放到它下一个同级之前；已经是最后一个就传 null（追加到末尾）。
  const beforeId =
    target.zone === 'before' ? node.nodeId : (siblings[index + 1]?.nodeId ?? null);
  moveNode(source, node.parentId, beforeId);
}

/** 拖到空白处 = 移到根目录末尾。 */
function onDropRoot(event: DragEvent): void {
  event.preventDefault();
  const source = dragId.value;
  dragId.value = null;
  dropTarget.value = null;
  if (source) moveNode(source, null, null);
}

function rowClass(node: TreeNode): Record<string, boolean> {
  const target = dropTarget.value;
  const hit = target?.nodeId === node.nodeId;
  return {
    active: state.activeNodeId === node.nodeId,
    dragging: dragId.value === node.nodeId,
    'drop-before': hit && target.zone === 'before',
    'drop-after': hit && target.zone === 'after',
    'drop-inside': hit && target.zone === 'inside',
  };
}

async function activate(node: TreeNode): Promise<void> {
  if (node.type === 'dir') toggleExpanded(node.nodeId);
  else await openNode(node.nodeId);
}
</script>

<template>
  <aside class="pane pane-tree">
    <div class="pane-head">
      <span class="pane-head-title">文档</span>
      <button class="icon-btn" title="搜索文档（Ctrl+Shift+P）" @click="openPalette()">
        <Icon name="search" />
      </button>
      <button class="icon-btn" title="新建文档" @click="createNode('doc', null)">
        <Icon name="plus" />
      </button>
      <button class="icon-btn" title="新建目录" @click="createNode('dir', null)">
        <Icon name="folder-plus" />
      </button>
    </div>

    <div
      class="pane-scroll"
      @dragover.prevent
      @drop="onDropRoot"
      @contextmenu.prevent.self="openMenu($event, null)"
    >
      <p v-if="!rows.length" class="tree-empty">还没有文档，点上面的 + 新建一篇</p>

      <div
        v-for="{ node, depth } in rows"
        :key="node.nodeId"
        class="tree-row"
        :class="rowClass(node)"
        :style="{ paddingLeft: `${depth * 12 + 6}px` }"
        draggable="true"
        @click="activate(node)"
        @dblclick="startRename(node)"
        @contextmenu.prevent.stop="openMenu($event, node)"
        @dragstart="dragId = node.nodeId"
        @dragend="((dragId = null), (dropTarget = null))"
        @dragover="onDragOver($event, node)"
        @dragleave="dropTarget = null"
        @drop="onDrop($event, node)"
      >
        <span
          v-if="node.type === 'dir'"
          class="tree-caret"
          :class="{ open: state.expanded.includes(node.nodeId) }"
        >
          <Icon name="chevron" />
        </span>
        <span v-else class="tree-caret" />

        <span class="tree-icon">
          <Icon
            :name="
              node.type === 'dir'
                ? state.expanded.includes(node.nodeId)
                  ? 'folder-open'
                  : 'folder'
                : 'file'
            "
          />
        </span>

        <input
          v-if="renamingId === node.nodeId"
          v-model="renameText"
          class="tree-rename"
          @click.stop
          @blur="commitRename"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="renamingId = null"
        />
        <span v-else class="tree-name" :title="node.name">{{ node.name }}</span>

        <span v-if="node.keywordEnabled" class="tree-badge" title="已注册全局关键词">
          <Icon name="key" />
        </span>
      </div>
    </div>
  </aside>

  <!-- 菜单挂在 body 层级，用遮罩接住「点别处关闭」，省掉全局 click 监听。 -->
  <Teleport to="body">
    <div v-if="menu" style="position: fixed; inset: 0; z-index: 59" @click="menu = null" @contextmenu.prevent="menu = null">
      <div class="ctx-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
        <button class="ctx-item" @click="menuCreate('doc')">
          <Icon name="plus" />新建文档
        </button>
        <button class="ctx-item" @click="menuCreate('dir')">
          <Icon name="folder-plus" />新建目录
        </button>
        <template v-if="!menu.node">
          <div class="ctx-sep" />
          <button class="ctx-item" @click="menuExport">
            <Icon name="download" />导出全部文档
          </button>
        </template>
        <template v-if="menu.node">
          <div class="ctx-sep" />
          <button class="ctx-item" @click="((renamingId = null), startRename(menu!.node!), (menu = null))">
            <Icon name="edit" />重命名
          </button>
          <button
            v-if="menu.node.type === 'doc'"
            class="ctx-item"
            @click="(emit('keyword', menu!.node!.nodeId), (menu = null))"
          >
            <Icon name="key" />关键词设置
          </button>
          <button class="ctx-item" @click="menuExport">
            <Icon name="download" />
            {{ menu.node.type === 'dir' ? '导出此目录' : '导出为 .md' }}
          </button>
          <div class="ctx-sep" />
          <button class="ctx-item danger" @click="menuDelete">
            <Icon name="trash" />删除
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
