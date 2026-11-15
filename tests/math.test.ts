import { describe, expect, it } from 'vitest';
import { renderMathDelimiters } from '../src/lib/math';

describe('renderMathDelimiters', () => {
  it('支持单行和多行展示公式', () => {
    expect(renderMathDelimiters('\\[x^2\\]\n\\[\ny = x + 1\n\\]'))
      .toBe('$$x^2$$\n$$\ny = x + 1\n$$');
  });

  it('保留代码块、未闭合公式和原有美元分隔符', () => {
    const markdown = '```tex\n\\[x\\]\n```\n~~~\n\\[y\\]\n~~~\n    \\[code\\]\n正文 \\[inline\\] 仍是文字\n\\[z\n$$a$$';
    expect(renderMathDelimiters(markdown)).toBe(markdown);
  });
});
