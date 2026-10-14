import { describe, expect, it } from 'vitest';
import { firstHeading, parseOutline } from '../src/lib/outline';

describe('parseOutline', () => {
  it('按出现顺序取各级标题，带上行号', () => {
    const items = parseOutline(['# 一', '正文', '### 三', '## 二'].join('\n'));
    expect(items).toEqual([
      { level: 1, text: '一', line: 0 },
      { level: 3, text: '三', line: 2 },
      { level: 2, text: '二', line: 3 },
    ]);
  });

  it('七个 # 不是标题', () => {
    expect(parseOutline('####### 不是标题')).toEqual([]);
  });

  it('# 后面没有空格不是标题', () => {
    expect(parseOutline('#标签')).toEqual([]);
  });

  it('去掉可选的收尾 #', () => {
    expect(parseOutline('## 标题 ##')[0].text).toBe('标题');
  });

  it('正文里的 # 不会被当成收尾标记', () => {
    expect(parseOutline('# C# 入门')[0].text).toBe('C# 入门');
  });

  it('只有 # 没有内容时不入列', () => {
    expect(parseOutline('#   \n##  ##')).toEqual([]);
  });

  // 这是手写解析最常见的错：Shell 示例里的注释被当成一级标题塞进大纲。
  it('跳过 ``` 围栏里的内容', () => {
    const items = parseOutline(['# 真标题', '```sh', '# 这是注释', '```', '## 也是真的'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['真标题', '也是真的']);
  });

  it('~~~ 围栏同样生效', () => {
    const items = parseOutline(['~~~', '# 注释', '~~~', '# 真标题'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['真标题']);
  });

  it('``` 开的围栏不会被 ~~~ 关掉', () => {
    const items = parseOutline(['```', '~~~', '# 还在围栏里', '```', '# 出来了'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['出来了']);
  });

  it('更长的围栏与前导空格都认', () => {
    const items = parseOutline(['   `````', '# 注释', '   `````', '# 真标题'].join('\n'));
    expect(items.map((item) => item.text)).toEqual(['真标题']);
  });

  it('围栏没闭合时后面全部当代码，不误报标题', () => {
    expect(parseOutline(['```', '# 注释', '# 还是注释'].join('\n'))).toEqual([]);
  });

  it('空正文给空列表', () => {
    expect(parseOutline('')).toEqual([]);
  });
});

describe('firstHeading', () => {
  it('取第一个标题，不限定级别', () => {
    expect(firstHeading('### 三级也算\n# 后面的一级')).toBe('三级也算');
  });

  it('没有标题时返回空串', () => {
    expect(firstHeading('只有正文')).toBe('');
  });

  it('围栏里的注释不会被当成标题拿去改文档名', () => {
    expect(firstHeading(['```', '# npm install', '```', '# 真标题'].join('\n'))).toBe('真标题');
  });
});
