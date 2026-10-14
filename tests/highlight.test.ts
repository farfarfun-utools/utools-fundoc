// 高亮切分的测试。
//
// 最要紧的性质是「拼回去等于原文」：片段是直接渲染给用户看的，任何丢字或重复
// 都会让搜索结果里的标题变得不对。每条用例都顺手验这一点。
import { describe, expect, it } from 'vitest';
import { segmentMatches } from '../src/lib/highlight';

/** 片段拼回原文。 */
const joined = (text: string, query: string) =>
  segmentMatches(text, query)
    .map((segment) => segment.text)
    .join('');

/** 只取高亮的那些片段。 */
const hits = (text: string, query: string) =>
  segmentMatches(text, query)
    .filter((segment) => segment.hit)
    .map((segment) => segment.text);

describe('segmentMatches', () => {
  it('切出命中和未命中的片段', () => {
    expect(segmentMatches('线性代数导论', '代数')).toEqual([
      { text: '线性', hit: false },
      { text: '代数', hit: true },
      { text: '导论', hit: false },
    ]);
  });

  it('命中在开头或结尾时不产生空片段', () => {
    expect(segmentMatches('矩阵乘法', '矩阵')).toEqual([
      { text: '矩阵', hit: true },
      { text: '乘法', hit: false },
    ]);
    expect(segmentMatches('矩阵乘法', '乘法')).toEqual([
      { text: '矩阵', hit: false },
      { text: '乘法', hit: true },
    ]);
  });

  it('整段命中时只有一个片段', () => {
    expect(segmentMatches('矩阵', '矩阵')).toEqual([{ text: '矩阵', hit: true }]);
  });

  it('同一个词出现多次全都高亮', () => {
    expect(hits('矩阵乘矩阵', '矩阵')).toEqual(['矩阵', '矩阵']);
    expect(joined('矩阵乘矩阵', '矩阵')).toBe('矩阵乘矩阵');
  });

  it('大小写不敏感，但保留原文的大小写', () => {
    expect(segmentMatches('Linear Algebra', 'ALGEBRA')).toEqual([
      { text: 'Linear ', hit: false },
      { text: 'Algebra', hit: true },
    ]);
  });

  it('多个词各自高亮', () => {
    expect(hits('线性代数与矩阵论', '线性 矩阵')).toEqual(['线性', '矩阵']);
  });

  it('重叠的命中合并成一段，不会套出两层高亮', () => {
    // 「学」在「数学」里面：不合并就会切出 [数][学][学] 这种嵌套结果。
    const segments = segmentMatches('数学分析', '数学 学');

    expect(segments).toEqual([
      { text: '数学', hit: true },
      { text: '分析', hit: false },
    ]);
    expect(joined('数学分析', '数学 学')).toBe('数学分析');
  });

  it('紧挨着的两处命中也并成一段', () => {
    // 分成两段渲染出来是两个挨在一起的 <mark>，和一个合起来的看不出区别，合并更省事。
    expect(segmentMatches('ab', 'a b')).toEqual([{ text: 'ab', hit: true }]);
  });

  it('词在后面先出现时按原文顺序排片段', () => {
    // tokenize 保留输入顺序，所以 ranges 里 '矩阵' 在 '线性' 前面，靠排序纠正。
    expect(segmentMatches('线性代数与矩阵', '矩阵 线性')).toEqual([
      { text: '线性', hit: true },
      { text: '代数与', hit: false },
      { text: '矩阵', hit: true },
    ]);
  });

  it('没命中时整段作为一个未命中片段返回', () => {
    expect(segmentMatches('线性代数', '拓扑')).toEqual([{ text: '线性代数', hit: false }]);
  });

  it('空查询或空文本不抛错', () => {
    expect(segmentMatches('线性代数', '')).toEqual([{ text: '线性代数', hit: false }]);
    expect(segmentMatches('线性代数', '   ')).toEqual([{ text: '线性代数', hit: false }]);
    expect(segmentMatches('', '矩阵')).toEqual([{ text: '', hit: false }]);
  });

  it('含正则元字符的查询按字面匹配', () => {
    // 实现走的是 indexOf 而不是正则，这条用例把这个前提钉住。
    expect(hits('价格 (含税) 100', '(含税)')).toEqual(['(含税)']);
    expect(hits('a.b', '.')).toEqual(['.']);
    expect(hits('aXb', '.')).toEqual([]);
  });
});
