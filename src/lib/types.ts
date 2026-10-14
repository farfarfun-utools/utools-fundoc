/** 节点类型：目录或文档。 */
export type NodeType = 'dir' | 'doc';

/**
 * 节点元数据，对应数据库里的 `meta@<nodeId>` 文档。
 *
 * 刻意**不含正文**：画左侧目录树要遍历所有节点，而 `allDocs` 会把整条文档搬进渲染进程。
 * 正文另存 `body@<nodeId>`，按需读取。详见 docs/design.md §3.2。
 */
export type NodeMeta = {
  _id: string;
  _rev?: string;
  /** nanoid，稳定不变 —— 重命名、移动都不会改它，关键词注册才能绑得住。 */
  nodeId: string;
  type: NodeType;
  /** 目录名 / 文档标题。 */
  name: string;
  /** 父节点 nodeId；null 表示挂在根上。 */
  parentId: string | null;
  /** 同级排序。稀疏整数，插入时取相邻中值，避免拖一下就重写整个同级列表。 */
  order: number;
  createdAt: number;
  updatedAt: number;

  // —— 以下仅 type === 'doc' 有意义 ——
  /** 是否注册为 uTools 全局关键词。 */
  keywordEnabled?: boolean;
  /** 自定义关键词。开关打开而这里为空时，用 `name` 当关键词（docs/design.md §5.1）。 */
  keywords?: string[];
  /** 正文字节数，给容量预警用。 */
  bodySize?: number;
};

/** 装好的树节点。`children` 与 `depth` 是内存结构，不落盘。 */
export type TreeNode = NodeMeta & {
  children: TreeNode[];
  depth: number;
};

/** 文档正文，对应数据库里的 `body@<nodeId>` 文档。 */
export type NodeBody = {
  _id: string;
  _rev?: string;
  nodeId: string;
  markdown: string;
  updatedAt: number;
};

/**
 * 编辑器模式，取值与 Vditor 的 `options.mode` 一一对应。
 *
 * - `wysiwyg` 所见即所得
 * - `ir` 即时渲染（类 Typora，单屏）
 * - `sv` 分屏预览（左右双屏）
 */
export type EditorMode = 'wysiwyg' | 'ir' | 'sv';

/** 外观：跟随 uTools / 强制亮 / 强制暗。 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 全局设置，整条存在 `dbStorage` 里（单条远不到 1MB）。 */
export type Settings = {
  /** 编辑器默认模式。 */
  mode: EditorMode;
  theme: ThemeMode;
  /** 正文首个一级标题变化时，是否同步更新节点名。 */
  syncTitleFromHeading: boolean;
  /** 大纲与正文里的标题是否自动编号。只影响显示，不写进 Markdown（lib/heading-number.ts）。 */
  headingNumber: boolean;
  /** 自动保存防抖毫秒数。 */
  autoSaveDelay: number;
  /** 大纲面板是否展开。 */
  outlineVisible: boolean;
  /** 文档树面板是否展开。 */
  treeVisible: boolean;
};

/** 出厂设置。 */
export const DEFAULT_SETTINGS: Settings = {
  mode: 'ir',
  theme: 'system',
  syncTitleFromHeading: true,
  headingNumber: true,
  autoSaveDelay: 800,
  outlineVisible: true,
  treeVisible: true,
};

/** 一条大纲条目。 */
export type OutlineItem = {
  level: number;
  text: string;
  /** 在 Markdown 源码里的行号，从 0 起。 */
  line: number;
};
