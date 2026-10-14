import { describe, expect, it, vi } from 'vitest';
import {
  createBodyReader,
  makeSnippet,
  pathOfMeta,
  searchDocs,
  tokenize,
  type BodyDoc,
  type SearchableMeta,
} from '../src/lib/search';

function meta(
  nodeId: string,
  name: string,
  options: Partial<SearchableMeta> = {},
): SearchableMeta {
  return { nodeId, type: 'doc', name, parentId: null, updatedAt: 1, ...options };
}

const dir = (nodeId: string, name: string, parentId: string | null = null): SearchableMeta =>
  meta(nodeId, name, { type: 'dir', parentId });

const ids = (metas: SearchableMeta[], query: string, options = {}) =>
  searchDocs(metas, query, options).map((hit) => hit.nodeId);

describe('tokenize', () => {
  it('按空白切词并转小写', () => {
    expect(tokenize('  Linear   Algebra ')).toEqual(['linear', 'algebra']);
  });

  it('空查询得到空数组', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('pathOfMeta', () => {
  const metas = [dir('math', '数学'), dir('linear', '线性代数', 'math'), meta('v', '向量', { parentId: 'linear' })];
  const byId = new Map(metas.map((item) => [item.nodeId, item]));

  it('拼出完整路径', () => {
    expect(pathOfMeta(byId, byId.get('v'))).toBe('数学/线性代数/向量');
  });

  it('节点不存在时返回空串', () => {
    expect(pathOfMeta(byId, undefined)).toBe('');
  });

  it('空名字显示为「未命名」', () => {
    const one = new Map([['x', meta('x', '')]]);
    expect(pathOfMeta(one, one.get('x'))).toBe('未命名');
  });

  // 同步事故会造出 A→B→A，拼路径时撞上就是死循环。
  it('父链成环也不会卡死', () => {
    const cyclic = new Map([
      ['a', dir('a', 'A', 'b')],
      ['b', dir('b', 'B', 'a')],
    ]);
    expect(pathOfMeta(cyclic, cyclic.get('a'))).toBe('B/A');
  });
});

describe('makeSnippet', () => {
  it('命中词两侧各留一些上下文，并加省略号', () => {
    const body = `${'前'.repeat(50)}命中${'后'.repeat(50)}`;
    const snippet = makeSnippet(body, '命中');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('命中');
  });

  it('命中在开头时不加前省略号', () => {
    expect(makeSnippet('命中后面还有字', '命中')).toBe('命中后面还有字');
  });

  it('换行和连续空白压成单个空格', () => {
    expect(makeSnippet('第一行\n\n  第二行有命中', '命中')).toBe('第一行 第二行有命中');
  });

  it('没命中返回空串', () => {
    expect(makeSnippet('正文', '不存在')).toBe('');
  });
});

describe('searchDocs', () => {
  it('空查询返回空结果，不是全部文档', () => {
    expect(searchDocs([meta('a', '随便')], '')).toEqual([]);
    expect(searchDocs([meta('a', '随便')], '   ')).toEqual([]);
  });

  it('目录不参与结果，但参与拼路径', () => {
    const metas = [dir('math', '数学'), meta('v', '数学笔记', { parentId: 'math' })];
    const hits = searchDocs(metas, '数学');

    expect(hits.map((hit) => hit.nodeId)).toEqual(['v']);
    expect(hits[0].path).toBe('数学/数学笔记');
  });

  it('标题完全命中 > 前缀命中 > 包含命中', () => {
    const metas = [
      meta('includes', '我的线性代数笔记'),
      meta('prefix', '线性代数导论'),
      meta('exact', '线性代数'),
    ];
    expect(ids(metas, '线性代数')).toEqual(['exact', 'prefix', 'includes']);
  });

  it('大小写不敏感', () => {
    expect(ids([meta('a', 'Linear Algebra')], 'LINEAR')).toEqual(['a']);
  });

  it('标题命中排在关键词命中前面', () => {
    const metas = [
      meta('kw', '别的标题', { keywords: ['线性代数'] }),
      meta('name', '线性代数'),
    ];
    const hits = searchDocs(metas, '线性代数');
    expect(hits.map((hit) => hit.nodeId)).toEqual(['name', 'kw']);
    expect(hits[0].field).toBe('name');
    expect(hits[1].field).toBe('keyword');
  });

  it('关键词取最高的那条打分', () => {
    const metas = [
      meta('a', 'A', { keywords: ['数学笔记', '线性代数'] }),
      meta('b', 'B', { keywords: ['我的线性代数'] }),
    ];
    // a 的 `线性代数` 是完全命中，b 只是包含命中。
    expect(ids(metas, '线性代数')).toEqual(['a', 'b']);
  });

  it('同分时更新时间新的在前', () => {
    const metas = [
      meta('old', '线性代数', { updatedAt: 100 }),
      meta('new', '线性代数', { updatedAt: 200 }),
    ];
    expect(ids(metas, '线性代数')).toEqual(['new', 'old']);
  });

  it('limit 生效', () => {
    const metas = Array.from({ length: 20 }, (_, index) => meta(`n${index}`, `笔记${index}`));
    expect(searchDocs(metas, '笔记')).toHaveLength(8);
    expect(searchDocs(metas, '笔记', { limit: 3 })).toHaveLength(3);
  });

  it('空标题显示为「未命名文档」', () => {
    expect(searchDocs([meta('a', '', { keywords: ['标签'] })], '标签')[0].name).toBe('未命名文档');
  });

  describe('多词是 AND', () => {
    it('每个词都要命中才算', () => {
      const metas = [
        meta('both', '线性代数 习题'),
        meta('one', '线性代数 导论'),
      ];
      expect(ids(metas, '线性代数 习题')).toEqual(['both']);
    });

    it('两个词可以分别命中标题和关键词', () => {
      const metas = [meta('a', '线性代数', { keywords: ['习题'] })];
      expect(ids(metas, '线性代数 习题')).toEqual(['a']);
    });

    it('命中更多/更精确的词总分更高', () => {
      const metas = [
        meta('weak', '线性代数相关的习题集'),
        meta('strong', '线性代数', { keywords: ['习题'] }),
      ];
      // strong：标题完全命中 + 关键词完全命中；weak：两个词都只是包含命中。
      expect(ids(metas, '线性代数 习题')).toEqual(['strong', 'weak']);
    });
  });

  describe('正文搜索', () => {
    const bodies: Record<string, string> = {
      a: '这篇正文里提到了矩阵分解',
      b: '另一篇也提到矩阵，而且矩阵出现了很多次：矩阵矩阵矩阵矩阵',
    };
    const bodyOf = (nodeId: string) => bodies[nodeId] ?? null;

    it('不给 bodyOf 就完全不搜正文', () => {
      const metas = [meta('a', '标题无关')];
      expect(searchDocs(metas, '矩阵')).toEqual([]);
    });

    it('给了 bodyOf 就能搜到正文', () => {
      const metas = [meta('a', '标题无关')];
      const hits = searchDocs(metas, '矩阵', { bodyOf });

      expect(hits).toHaveLength(1);
      expect(hits[0].field).toBe('body');
      expect(hits[0].snippet).toContain('矩阵');
    });

    it('正文命中永远排在标题/关键词命中后面', () => {
      const metas = [
        meta('a', '标题无关'),
        meta('title', '矩阵'),
        meta('kw', '随便', { keywords: ['矩阵'] }),
      ];
      expect(ids(metas, '矩阵', { bodyOf })).toEqual(['title', 'kw', 'a']);
    });

    it('正文里出现次数多的靠前，但加分封顶', () => {
      const metas = [meta('a', 'A'), meta('b', 'B')];
      const hits = searchDocs(metas, '矩阵', { bodyOf });

      expect(hits.map((hit) => hit.nodeId)).toEqual(['b', 'a']);
      // 封顶 5 分：再怎么重复也越不过关键词包含命中（30 分）那一档。
      expect(hits[0].score - hits[1].score).toBeLessThanOrEqual(5);
    });

    // preload 里每敲一个键都要重搜一遍，全量读正文太贵。正文分值低于任何标题/关键词档位，
    // 所以第一轮凑够数时正文命中根本挤不进来 —— 这时一次都不该读。
    it('标题命中已经够数时一次正文都不读', () => {
      const spy = vi.fn(bodyOf);
      const metas = Array.from({ length: 10 }, (_, index) => meta(`n${index}`, `矩阵${index}`));
      metas.push(meta('body-only', '标题无关'));

      searchDocs(metas, '矩阵', { bodyOf: spy, limit: 8 });
      expect(spy).not.toHaveBeenCalled();
    });

    it('标题命中不够数时才去读正文', () => {
      const spy = vi.fn(bodyOf);
      const metas = [meta('title', '矩阵'), meta('a', '标题无关')];

      searchDocs(metas, '矩阵', { bodyOf: spy, limit: 8 });
      expect(spy).toHaveBeenCalled();
    });

    it('正文为空或读不到的文档被跳过', () => {
      const metas = [meta('ghost', '标题无关')];
      expect(searchDocs(metas, '矩阵', { bodyOf: () => null })).toEqual([]);
      expect(searchDocs(metas, '矩阵', { bodyOf: () => '' })).toEqual([]);
    });

    it('多词时标题和正文可以各命中一个', () => {
      const metas = [meta('a', '线性代数')];
      expect(
        ids(metas, '线性代数 矩阵', { bodyOf: () => '正文里有矩阵' }),
      ).toEqual(['a']);
    });

    it('多词时有一个词正文里也没有就不算命中', () => {
      const metas = [meta('a', '线性代数')];
      expect(ids(metas, '线性代数 不存在的词', { bodyOf: () => '正文里有矩阵' })).toEqual([]);
    });

    it('标题沾了分但靠正文补全时，field 仍是 body，好让界面显示片段', () => {
      const metas = [meta('a', '线性代数')];
      const hits = searchDocs(metas, '线性代数 矩阵', { bodyOf: () => '正文里有矩阵' });

      expect(hits[0].field).toBe('body');
      expect(hits[0].snippet).toContain('矩阵');
    });
  });
});

describe('createBodyReader', () => {
  /** 记录每次 get 的假库。`reads` 是关键 —— 缓存有没有生效全看它。 */
  function fakeStore(docs: Record<string, string>) {
    const reads: string[] = [];
    return {
      reads,
      get(id: string): BodyDoc | null {
        reads.push(id);
        return id in docs ? { _id: id, markdown: docs[id] } : null;
      },
    };
  }

  const byId = (metas: SearchableMeta[]) => new Map(metas.map((item) => [item.nodeId, item]));

  it('查询词太短时返回 undefined，一次库都不读', () => {
    const store = fakeStore({ 'body@a': '矩阵' });
    const reader = createBodyReader(store);

    expect(reader.forQuery('矩', byId([meta('a', '标题')]))).toBeUndefined();
    expect(reader.forQuery('', byId([]))).toBeUndefined();
    expect(store.reads).toEqual([]);
  });

  it('按前缀拼 id 取正文', () => {
    const store = fakeStore({ 'body@a': '# 线性代数' });
    const read = createBodyReader(store).forQuery('矩阵', byId([meta('a', '标题')]));

    expect(read?.('a')).toBe('# 线性代数');
    expect(store.reads).toEqual(['body@a']);
  });

  it('前缀可以换', () => {
    const store = fakeStore({ 'doc:a': '正文' });
    const read = createBodyReader(store, { bodyPrefix: 'doc:' }).forQuery(
      '矩阵',
      byId([meta('a', '标题')]),
    );

    expect(read?.('a')).toBe('正文');
  });

  it('读不到的文档当空正文，而且不会反复去库里试', () => {
    const store = fakeStore({});
    const read = createBodyReader(store).forQuery('矩阵', byId([meta('ghost', '标题')]));

    expect(read?.('ghost')).toBe('');
    expect(read?.('ghost')).toBe('');
    expect(store.reads).toEqual(['body@ghost']);
  });

  it('同一个 updatedAt 下只读一次库', () => {
    const store = fakeStore({ 'body@a': '矩阵乘法' });
    const reader = createBodyReader(store);
    const metas = byId([meta('a', '标题', { updatedAt: 7 })]);

    expect(reader.forQuery('矩阵', metas)?.('a')).toBe('矩阵乘法');
    // 换查询词也算新的一轮搜索，缓存要跨轮生效 —— preload 里每敲一个键都是新的一轮。
    expect(reader.forQuery('乘法', metas)?.('a')).toBe('矩阵乘法');
    expect(store.reads).toEqual(['body@a']);
  });

  it('updatedAt 变了就重新读', () => {
    const docs: Record<string, string> = { 'body@a': '旧正文' };
    const store = fakeStore(docs);
    const reader = createBodyReader(store);

    expect(reader.forQuery('矩阵', byId([meta('a', '标题', { updatedAt: 1 })]))?.('a')).toBe('旧正文');
    docs['body@a'] = '新正文';
    // 元数据没动的话读到的还是缓存里的旧正文 —— 这正是「靠 updatedAt 失效」的含义。
    expect(reader.forQuery('矩阵', byId([meta('a', '标题', { updatedAt: 1 })]))?.('a')).toBe('旧正文');
    expect(reader.forQuery('矩阵', byId([meta('a', '标题', { updatedAt: 2 })]))?.('a')).toBe('新正文');
    expect(store.reads).toEqual(['body@a', 'body@a']);
  });

  it('clear() 之后重新读库', () => {
    const store = fakeStore({ 'body@a': '矩阵' });
    const reader = createBodyReader(store);
    const metas = byId([meta('a', '标题')]);

    reader.forQuery('矩阵', metas)?.('a');
    reader.clear();
    reader.forQuery('矩阵', metas)?.('a');

    expect(store.reads).toEqual(['body@a', 'body@a']);
  });

  it('超过上限时整个缓存清掉', () => {
    const docs: Record<string, string> = { 'body@a': 'A', 'body@b': 'B', 'body@c': 'C' };
    const store = fakeStore(docs);
    const reader = createBodyReader(store, { cacheLimit: 2 });
    const metas = byId([meta('a', 'A'), meta('b', 'B'), meta('c', 'C')]);
    const read = reader.forQuery('矩阵', metas);

    read?.('a');
    read?.('b');
    // 这一下把缓存填到上限，于是 c 之前先整个清空，a 的缓存跟着没了。
    read?.('c');
    read?.('a');

    expect(store.reads).toEqual(['body@a', 'body@b', 'body@c', 'body@a']);
  });
});
