import { describe, expect, it } from 'vitest';
import { buildScrollMap, flipMap, mapScroll, type Anchor } from '../src/lib/scroll-map';

/** 只看 from，断言「留下了哪些锚点」时比写全对象清楚。 */
const froms = (map: Anchor[]): number[] => map.map((anchor) => anchor.from);

describe('buildScrollMap', () => {
  it('自动补上首尾两对', () => {
    expect(buildScrollMap([], 500, 800)).toEqual([
      { from: 0, to: 0 },
      { from: 500, to: 800 },
    ]);
  });

  it('中间锚点按源码位置排好序', () => {
    const map = buildScrollMap(
      [
        { from: 300, to: 400 },
        { from: 100, to: 120 },
        { from: 200, to: 260 },
      ],
      500,
      800,
    );
    expect(froms(map)).toEqual([0, 100, 200, 300, 500]);
  });

  it('丢掉倒退的锚点', () => {
    // 第二个点的 to 比第一个小 —— 留着会让这一段的滚动方向反掉。
    const map = buildScrollMap(
      [
        { from: 100, to: 300 },
        { from: 200, to: 200 },
        { from: 300, to: 400 },
      ],
      500,
      800,
    );
    expect(map).toEqual([
      { from: 0, to: 0 },
      { from: 100, to: 300 },
      { from: 300, to: 400 },
      { from: 500, to: 800 },
    ]);
  });

  it('丢掉 from 相等的重复锚点', () => {
    // 同一行量出两个值（或两个标题挤在一行）时会相等，插值会除以 0。
    const map = buildScrollMap(
      [
        { from: 100, to: 120 },
        { from: 100, to: 160 },
      ],
      500,
      800,
    );
    expect(map).toEqual([
      { from: 0, to: 0 },
      { from: 100, to: 120 },
      { from: 500, to: 800 },
    ]);
  });

  it('丢掉非有限值', () => {
    const map = buildScrollMap(
      [
        { from: Number.NaN, to: 100 },
        { from: 100, to: Number.POSITIVE_INFINITY },
        { from: 200, to: 260 },
      ],
      500,
      800,
    );
    expect(froms(map)).toEqual([0, 200, 500]);
  });

  it('丢掉落在首尾之外的锚点', () => {
    const map = buildScrollMap(
      [
        { from: 0, to: 0 },
        { from: -10, to: 50 },
        { from: 200, to: 260 },
        { from: 600, to: 900 },
        { from: 400, to: 1000 },
      ],
      500,
      800,
    );
    expect(froms(map)).toEqual([0, 200, 500]);
  });

  it('两边都滚不动时退化成两个零点', () => {
    expect(buildScrollMap([{ from: 100, to: 200 }], 0, 0)).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 0 },
    ]);
  });

  it('只有一侧能滚时也至少有两个元素', () => {
    // 内容还没渲染完时会出现这种情况，调用方不必特判。
    expect(buildScrollMap([], 500, 0)).toEqual([
      { from: 0, to: 0 },
      { from: 500, to: 0 },
    ]);
  });

  it('负的最大滚动量按 0 处理', () => {
    expect(buildScrollMap([], -20, -5)).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 0 },
    ]);
  });

  it('不改动传进来的数组', () => {
    const anchors = [
      { from: 300, to: 400 },
      { from: 100, to: 120 },
    ];
    buildScrollMap(anchors, 500, 800);
    expect(froms(anchors)).toEqual([300, 100]);
  });
});

describe('mapScroll', () => {
  const map = buildScrollMap(
    [
      { from: 100, to: 300 },
      { from: 200, to: 400 },
    ],
    400,
    800,
  );

  it('顶部对顶部', () => {
    expect(mapScroll(map, 0)).toBe(0);
  });

  it('底部对底部', () => {
    expect(mapScroll(map, 400)).toBe(800);
  });

  it('锚点上取锚点值', () => {
    expect(mapScroll(map, 100)).toBe(300);
    expect(mapScroll(map, 200)).toBe(400);
  });

  it('段内线性插值', () => {
    // 0→100 这一段对应 0→300，走一半就是 150。
    expect(mapScroll(map, 50)).toBe(150);
    // 200→400 对应 400→800，走四分之一是 500。
    expect(mapScroll(map, 250)).toBe(500);
  });

  it('越界往两端夹', () => {
    expect(mapScroll(map, -100)).toBe(0);
    expect(mapScroll(map, 9999)).toBe(800);
  });

  it('空映射返回 0', () => {
    expect(mapScroll([], 123)).toBe(0);
  });

  it('退化映射恒为 0', () => {
    const flat = buildScrollMap([], 0, 0);
    expect(mapScroll(flat, 0)).toBe(0);
    expect(mapScroll(flat, 500)).toBe(0);
  });

  it('全程单调不减', () => {
    let previous = -1;
    for (let value = 0; value <= 400; value += 7) {
      const mapped = mapScroll(map, value);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
  });
});

describe('flipMap', () => {
  it('互换 from 与 to', () => {
    expect(
      flipMap([
        { from: 0, to: 0 },
        { from: 100, to: 300 },
      ]),
    ).toEqual([
      { from: 0, to: 0 },
      { from: 300, to: 100 },
    ]);
  });

  // 这是双向同步不互相打架的前提：反向映射必须是正向的严格逆。
  it('反向映射把锚点值精确还原', () => {
    const forward = buildScrollMap(
      [
        { from: 100, to: 300 },
        { from: 200, to: 400 },
      ],
      400,
      800,
    );
    const backward = flipMap(forward);
    for (const anchor of forward) {
      expect(mapScroll(backward, mapScroll(forward, anchor.from))).toBe(anchor.from);
    }
  });

  it('段内往返也还原', () => {
    const forward = buildScrollMap([{ from: 100, to: 300 }], 400, 800);
    const backward = flipMap(forward);
    for (const value of [13, 50, 99, 150, 321]) {
      expect(mapScroll(backward, mapScroll(forward, value))).toBeCloseTo(value, 10);
    }
  });

  it('翻两次回到原样', () => {
    const map = buildScrollMap([{ from: 100, to: 300 }], 400, 800);
    expect(flipMap(flipMap(map))).toEqual(map);
  });
});
