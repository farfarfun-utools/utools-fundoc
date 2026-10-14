import { describe, expect, it } from 'vitest';
import { numberHeadings } from '../src/lib/heading-number';

/** 把 `# / ## / ###` 这样的写法转成层级数组，用例里读起来更像真文档。 */
const levels = (marks: string) => marks.split(/\s+/).filter(Boolean).map((mark) => mark.length);

describe('numberHeadings', () => {
  it('标准的层级结构逐级编号', () => {
    expect(numberHeadings(levels('# ## ## ### # ##'))).toEqual([
      '1',
      '1.1',
      '1.2',
      '1.2.1',
      '2',
      '2.1',
    ]);
  });

  it('整篇从二级标题开头也从 1 起编', () => {
    // uTools 里的笔记常常没有一级标题（标题栏已经有文档名了）。按 # 个数硬编
    // 会得到 0.1 / 0.2 这种东西。
    expect(numberHeadings(levels('## ## ###'))).toEqual(['1', '2', '2.1']);
  });

  it('跳级只算一层嵌套，不产生 1.0.1', () => {
    expect(numberHeadings(levels('# ### ####'))).toEqual(['1', '1.1', '1.1.1']);
  });

  it('层级变浅时接着同深度往下数，不重号', () => {
    // 这是跳级之后最容易出重号的地方：### 和后面的 ## 都是那个 # 的子节点。
    expect(numberHeadings(levels('# ### ## ##'))).toEqual(['1', '1.1', '1.2', '1.3']);
  });

  it('比开头更浅的标题算同级而不是补一层', () => {
    expect(numberHeadings(levels('## ### #'))).toEqual(['1', '1.1', '2']);
  });

  it('六级全用上', () => {
    expect(numberHeadings(levels('# ## ### #### ##### ######'))).toEqual([
      '1',
      '1.1',
      '1.1.1',
      '1.1.1.1',
      '1.1.1.1.1',
      '1.1.1.1.1.1',
    ]);
  });

  it('同级连续时只有末位在涨', () => {
    expect(numberHeadings(levels('# # #'))).toEqual(['1', '2', '3']);
  });

  it('回到上层后，下层重新从 1 开始', () => {
    expect(numberHeadings(levels('# ## ### # ##'))).toEqual(['1', '1.1', '1.1.1', '2', '2.1']);
  });

  it('没有标题就是空数组', () => {
    expect(numberHeadings([])).toEqual([]);
  });
});
