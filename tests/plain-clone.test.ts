import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import { clonePlain } from '../src/lib/plain-clone';

describe('clonePlain', () => {
  it('深拷贝：改副本不影响原值', () => {
    const source = { a: { b: [1, 2] } };
    const copy = clonePlain(source);
    copy.a.b.push(3);
    expect(source.a.b).toEqual([1, 2]);
  });

  it('空值原样返回', () => {
    expect(clonePlain(null)).toBeNull();
    expect(clonePlain(undefined)).toBeUndefined();
  });

  // 这是这个函数存在的唯一理由：Vue 的响应式 Proxy 过不了 Electron 的结构化克隆，
  // 直接塞给 utools.db.put 会失败。
  it('脱掉 Vue 的响应式代理', () => {
    const state = reactive({ name: '线性代数', keywords: ['矩阵'] });
    const copy = clonePlain(state);
    expect(copy).toEqual({ name: '线性代数', keywords: ['矩阵'] });
    // 响应式对象上 ref 会被自动解包，但 Proxy 本身不该跟着过来。
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    state.name = '改了';
    expect(copy.name).toBe('线性代数');
  });

  it('嵌套的 ref 被解成普通值', () => {
    const state = reactive({ count: ref(1) });
    expect(clonePlain(state)).toEqual({ count: 1 });
  });
});
