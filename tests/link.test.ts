// 超链接地址规范化的测试。
//
// 这道闸门的输出直接交给 shellOpenExternal，也就是交给操作系统，所以「该拦的拦住」
// 比「该开的能开」更要紧 —— 下面放行和拦截两边的用例都写满。
import { describe, expect, it } from 'vitest';
import { externalLinkUrl } from '../src/lib/link';

describe('externalLinkUrl', () => {
  it('原样放行 http / https / mailto', () => {
    expect(externalLinkUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(externalLinkUrl('http://example.com')).toBe('http://example.com');
    expect(externalLinkUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
  });

  it('协议大小写不敏感', () => {
    expect(externalLinkUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
  });

  it('给光秃秃的域名补上 https', () => {
    expect(externalLinkUrl('example.com')).toBe('https://example.com');
    expect(externalLinkUrl('sub.example.co.uk/a/b')).toBe('https://sub.example.co.uk/a/b');
    expect(externalLinkUrl('example.com?q=1')).toBe('https://example.com?q=1');
  });

  it('去掉两头的空白', () => {
    expect(externalLinkUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('空地址返回 null', () => {
    expect(externalLinkUrl('')).toBeNull();
    expect(externalLinkUrl('   ')).toBeNull();
    expect(externalLinkUrl(null)).toBeNull();
    expect(externalLinkUrl(undefined)).toBeNull();
  });

  it('站内锚点不丢给浏览器', () => {
    expect(externalLinkUrl('#第一章')).toBeNull();
  });

  it('图片附件引用不丢给浏览器', () => {
    expect(externalLinkUrl('fundoc-asset://asset@abc123')).toBeNull();
  });

  it('相对路径不当成域名', () => {
    expect(externalLinkUrl('./other.md')).toBeNull();
    expect(externalLinkUrl('../a/b.md')).toBeNull();
    expect(externalLinkUrl('/abs/path')).toBeNull();
    expect(externalLinkUrl('plain-text')).toBeNull();
  });

  it('拦住白名单外的协议', () => {
    // 这几条是重点：正文是会跨设备同步的，别人写的一行 Markdown 不该能让本机
    // 执行脚本、读本地文件、或者唤起任意已注册的协议处理器。
    expect(externalLinkUrl('javascript:alert(1)')).toBeNull();
    expect(externalLinkUrl('JavaScript:alert(1)')).toBeNull();
    expect(externalLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(externalLinkUrl('file:///etc/passwd')).toBeNull();
    expect(externalLinkUrl('vbscript:msgbox(1)')).toBeNull();
    expect(externalLinkUrl('utools://foo')).toBeNull();
  });

  it('带协议头的地址不会被域名规则绕过', () => {
    // `javascript:example.com` 先命中 HAS_SCHEME，不会被补成 https。
    expect(externalLinkUrl('javascript:example.com')).toBeNull();
  });
});
