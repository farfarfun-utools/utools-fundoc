// 文档搜索的唯一实现：标题、关键词、正文。
//
// **这个文件被两处共用**：应用内的搜索面板（Ctrl+Shift+P），以及 preload.js 里的
// `onMainPush`（uTools 主搜索框直搜）。preload 是 CommonJS、跑在 Node 侧，没法 import
// TS 模块，所以构建时由 vite.preload.config.ts 把这个文件单独打成
// `utools/search-core.cjs` 给它 `require`。
//
// 为什么非要共用而不是各写一份：两边各一份打分逻辑，排序迟早不一致 —— 用户在主搜索框
// 和插件里搜同一个词得到不同顺序，只会以为是 bug。preload.js 里原本重复的 pathOf 和
// score 也一并收到这里了。
//
// 约束：**不要给这个文件加任何运行时 import**。它要能被单独打成一个自包含的 CJS 文件。

/** 搜索只需要元数据的这几个字段，不必是完整的 NodeMeta。 */
export type SearchableMeta = {
  nodeId: string;
  type: 'dir' | 'doc';
  name: string;
  parentId: string | null;
  updatedAt: number;
  keywords?: string[];
};

/** 命中来源。界面据此决定是否显示正文片段。 */
export type SearchField = 'name' | 'keyword' | 'body';

export type SearchHit = {
  nodeId: string;
  name: string;
  /** 形如 `笔记/数学/线性代数`，用于区分同名文档。 */
  path: string;
  field: SearchField;
  score: number;
  /** 正文命中时的上下文片段；标题/关键词命中时为空串。 */
  snippet: string;
};

/**
 * 各字段的命中分值。
 *
 * 标题 > 关键词 > 正文，且前缀命中优于包含命中 —— 用户打前几个字时，想要的几乎总是
 * 标题以此开头的那篇。正文分值刻意压得很低（10）：**任何**标题或关键词命中都该排在
 * 正文命中前面，这条性质让「标题命中已经够数就完全不必读正文」的优化成立。
 */
export const SCORE = {
  nameExact: 100,
  namePrefix: 80,
  nameIncludes: 60,
  keywordExact: 50,
  keywordPrefix: 40,
  keywordIncludes: 30,
  body: 10,
  /** 正文里出现次数越多越靠前，但最多再加这么些分，不能越过关键词那一档。 */
  bodyRepeatCap: 5,
} as const;

/** 默认返回条数。uTools 主搜索框一屏大约就这么多。 */
export const DEFAULT_LIMIT = 8;

/**
 * 正文搜索的最短查询长度。
 *
 * 单个字符就去翻正文没有意义：几乎每篇都会命中，结果全是噪音，而代价是把全库正文读一遍。
 * 标题和关键词不受这条限制，敲一个字照样能直达。
 */
export const MIN_BODY_QUERY = 2;

/** 正文片段在命中词两侧各取多少字符。 */
const SNIPPET_RADIUS = 30;

/**
 * 把查询串切成词。空白分隔，全部转小写。
 *
 * 不做中文分词：子串匹配本来就能处理中文，引入分词词典对一个文档插件不划算。
 *
 * @param query 原始查询串。
 * @returns 去空后的小写词数组。
 */
export function tokenize(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 拼出节点的完整路径。
 * @param byId nodeId → 元数据的映射，**必须包含目录**，否则路径只剩文档名那一段。
 * @param meta 起始节点。
 * @returns 形如 `笔记/数学/线性代数` 的路径。
 */
export function pathOfMeta(
  byId: Map<string, SearchableMeta>,
  meta: SearchableMeta | undefined,
): string {
  const segments: string[] = [];
  const seen = new Set<string>();
  let cursor = meta;
  // seen 防环：同步事故真的会造出 A→B→A，拼路径时撞上就会死循环。
  while (cursor && !seen.has(cursor.nodeId)) {
    seen.add(cursor.nodeId);
    segments.unshift(cursor.name || '未命名');
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return segments.join('/');
}

/** 给单个词在标题上打分；不匹配返回 0。 */
function scoreName(name: string, word: string): number {
  const target = name.toLowerCase();
  if (!target) return 0;
  if (target === word) return SCORE.nameExact;
  if (target.startsWith(word)) return SCORE.namePrefix;
  if (target.includes(word)) return SCORE.nameIncludes;
  return 0;
}

/** 给单个词在关键词列表上打分；取最高的那条。 */
function scoreKeywords(keywords: string[] | undefined, word: string): number {
  let best = 0;
  for (const keyword of keywords ?? []) {
    const item = String(keyword).toLowerCase();
    if (!item) continue;
    if (item === word) best = Math.max(best, SCORE.keywordExact);
    else if (item.startsWith(word)) best = Math.max(best, SCORE.keywordPrefix);
    else if (item.includes(word)) best = Math.max(best, SCORE.keywordIncludes);
  }
  return best;
}

/**
 * 截一段带上下文的正文片段，命中词两侧各留一些字符。
 *
 * @param body 正文。
 * @param word 已小写的命中词。
 * @returns 形如 `…上文 命中 下文…` 的单行片段；没命中返回空串。
 */
export function makeSnippet(body: string, word: string): string {
  const flat = body.replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(word);
  if (at < 0) return '';

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + word.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** 数一个词在正文里出现几次（最多数到 cap + 1 就够，不必扫完整篇）。 */
function countOccurrences(haystack: string, word: string, cap: number): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(word, from);
    if (at < 0) return count;
    count += 1;
    if (count > cap) return count;
    from = at + word.length;
  }
}

export type SearchOptions = {
  /**
   * 按需取正文。返回 null 表示没有正文。
   *
   * 做成回调而不是直接传一个 Map：调用方可以自己决定缓存策略，而且**标题命中已经够数时
   * 一次都不会被调用** —— preload 里每敲一个键都要重新搜一遍，全量读正文太贵。
   */
  bodyOf?: (nodeId: string) => string | null;
  /** 最多返回几条。 */
  limit?: number;
};

/**
 * 正文文档读出来的样子。
 *
 * 索引签名不是摆设：只写 `{ markdown?: unknown }` 的话全是可选属性，会触发 TS 的
 * weak type 检查，而 uTools 的 `DbDoc` 只声明了 `_id`/`_rev`，和它「没有共同属性」，
 * 直接把 `utools.db` 传进来会报错。
 */
export type BodyDoc = { markdown?: unknown; [key: string]: unknown };

/** 读正文只需要数据库的这一个方法。 */
export type BodyStore = { get(id: string): BodyDoc | null };

export type BodyReader = {
  /**
   * 为一次搜索生成 `bodyOf` 回调。
   * @param query 本次查询串。太短时返回 undefined —— 直接当 `options.bodyOf` 传进去即可。
   * @param metaById nodeId → 元数据，用来判断缓存是否过期。
   */
  forQuery(
    query: string,
    metaById: Map<string, SearchableMeta>,
  ): ((nodeId: string) => string) | undefined;
  /** 丢掉全部缓存。 */
  clear(): void;
};

/**
 * 造一个带缓存的正文读取器。
 *
 * 两边共用：preload 传 `utools.db`，界面传 `host.db`。两处都是常驻的，缓存能跨多次按键复用。
 * 缓存靠 `meta.updatedAt` 失效 —— 保存文档时元数据一定会跟着写，这个值变了就说明正文可能变了。
 *
 * @param store 数据库（只用到同步的 `get`）。
 * @param options.bodyPrefix 正文文档的 id 前缀。默认与 storage.ts 一致；
 *   本文件不能 import 它（要能单独打成自包含的 CJS），所以这里是一份刻意的常量副本。
 * @param options.cacheLimit 缓存条数上限。超了整个清掉，而不是做 LRU —— 不值得为这点事
 *   背一套淘汰逻辑。
 */
export function createBodyReader(
  store: BodyStore,
  options: { bodyPrefix?: string; cacheLimit?: number } = {},
): BodyReader {
  const prefix = options.bodyPrefix ?? 'body@';
  const limit = options.cacheLimit ?? 400;
  const cache = new Map<string, { markdown: string; metaUpdatedAt: number }>();

  return {
    forQuery(query, metaById) {
      if (tokenize(query).join('').length < MIN_BODY_QUERY) return undefined;
      return (nodeId: string) => {
        const stamp = metaById.get(nodeId)?.updatedAt ?? 0;
        const cached = cache.get(nodeId);
        if (cached && cached.metaUpdatedAt === stamp) return cached.markdown;

        // 同步 get 是阻塞式 IPC。只有「标题/关键词没凑够结果」时 searchDocs 才会走到这里，
        // 而且每篇只读一次，之后都走缓存。
        const doc = store.get(prefix + nodeId);
        const markdown = typeof doc?.markdown === 'string' ? doc.markdown : '';
        if (cache.size >= limit) cache.clear();
        cache.set(nodeId, { markdown, metaUpdatedAt: stamp });
        return markdown;
      };
    },
    clear: () => cache.clear(),
  };
}

type Candidate = {
  meta: SearchableMeta;
  score: number;
  field: SearchField;
  /** 命中正文的那个词，用来截片段。 */
  bodyWord: string;
};

/**
 * 搜索文档。
 *
 * 多个词之间是 **AND**：每个词都得在标题、关键词或正文里命中，总分是各词最佳分之和。
 * 单个词时就退化成「标题优先、其次关键词、最后正文」。
 *
 * @param metas 全部节点元数据，**含目录**（拼路径要用）。只有 `type === 'doc'` 参与打分。
 * @param query 查询串。
 * @param options 正文读取回调与条数上限。
 * @returns 按分数降序、同分按更新时间降序的命中列表。
 */
export function searchDocs(
  metas: SearchableMeta[],
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const words = tokenize(query);
  if (!words.length) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const byId = new Map(metas.map((meta) => [meta.nodeId, meta]));
  const docs = metas.filter((meta) => meta.type === 'doc');

  // ── 第一轮：只看标题和关键词，不读正文 ──
  const candidates: Candidate[] = [];
  /** 标题/关键词这一轮没能全词命中的文档，留给第二轮查正文。 */
  const pending: Array<{ meta: SearchableMeta; missing: string[]; score: number; field: SearchField }> =
    [];

  for (const meta of docs) {
    let total = 0;
    let bestField: SearchField = 'name';
    let bestScore = 0;
    const missing: string[] = [];

    for (const word of words) {
      const name = scoreName(meta.name || '', word);
      const keyword = scoreKeywords(meta.keywords, word);
      const hit = Math.max(name, keyword);
      if (!hit) {
        missing.push(word);
        continue;
      }
      total += hit;
      if (hit > bestScore) {
        bestScore = hit;
        bestField = name >= keyword ? 'name' : 'keyword';
      }
    }

    if (!missing.length) candidates.push({ meta, score: total, field: bestField, bodyWord: '' });
    else if (options.bodyOf) pending.push({ meta, missing, score: total, field: bestField });
  }

  // 正文分值低于任何标题/关键词档位，所以第一轮就凑够数时，正文命中不可能挤进前 N ——
  // 这时一次正文都不必读。preload 里每次按键都要重搜，这个短路是必须的。
  const needBody = options.bodyOf && candidates.length < limit;

  // ── 第二轮：补查正文 ──
  if (needBody) {
    for (const item of pending) {
      const body = options.bodyOf!(item.meta.nodeId);
      if (!body) continue;
      const haystack = body.toLowerCase();

      let total = item.score;
      let firstWord = '';
      let allHit = true;
      for (const word of item.missing) {
        const count = countOccurrences(haystack, word, SCORE.bodyRepeatCap);
        if (!count) {
          allHit = false;
          break;
        }
        // 出现次数越多越靠前，但封顶，免得一篇长文凭重复次数越过关键词命中。
        total += SCORE.body + Math.min(count - 1, SCORE.bodyRepeatCap);
        if (!firstWord) firstWord = word;
      }
      if (!allHit) continue;

      candidates.push({
        meta: item.meta,
        score: total,
        // 标题也沾了点分时仍标成 body：界面要显示正文片段，这才是用户需要看到的证据。
        field: 'body',
        bodyWord: firstWord,
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || right.meta.updatedAt - left.meta.updatedAt)
    .slice(0, limit)
    .map((item) => ({
      nodeId: item.meta.nodeId,
      name: item.meta.name || '未命名文档',
      path: pathOfMeta(byId, item.meta),
      field: item.field,
      score: item.score,
      snippet:
        item.field === 'body' && item.bodyWord
          ? makeSnippet(options.bodyOf?.(item.meta.nodeId) ?? '', item.bodyWord)
          : '',
    }));
}
