import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithin, settleWithin, timeoutError, withTimeout } from '../src/lib/deadline';

/** 永远不落地的 Promise —— 这整个模块就是为了对付它。 */
const never = () => new Promise<never>(() => {});

describe('timeoutError', () => {
  it('消息是给用户看的人话，带上等了多久', () => {
    // 这句会原样显示在提示条上，所以措辞算行为的一部分。
    expect(timeoutError('生成图片', 45_000).message).toBe('生成图片超时（等了 45 秒还没有结果）');
  });

  it('不足一秒也凑整成整数秒', () => {
    expect(timeoutError('取资源', 1_400).message).toBe('取资源超时（等了 1 秒还没有结果）');
  });
});

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('按时落地就原样返回结果', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, '算数')).resolves.toBe(7);
  });

  it('task 自己抛错时抛的是原错误，不是超时错误', async () => {
    const boom = new Error('渲染不了');
    await expect(withTimeout(Promise.reject(boom), 1_000, '渲染')).rejects.toBe(boom);
  });

  it('task 抛的不是 Error 也包成 Error', async () => {
    // Vditor 内部有几处 reject 的是字符串，直接往上扔会让 `error.message` 变成 undefined。
    await expect(withTimeout(Promise.reject('坏了'), 1_000, '渲染')).rejects.toThrow('坏了');
  });

  it('超过期限就抛超时错误', async () => {
    const task = withTimeout(never(), 1_000, '渲染文档');
    const assertion = expect(task).rejects.toThrow('渲染文档超时（等了 1 秒还没有结果）');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('差一毫秒还不算超时', async () => {
    const task = withTimeout(never(), 1_000, '渲染文档');
    let settled = false;
    void task.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(task).rejects.toThrow('超时');
  });

  it('task 落地后定时器要清掉', async () => {
    // 不清的话：跑单测时它撑着事件循环不让进程退出，线上则会在早就结束的操作上
    // 迟到地再报一次超时。所以这条用例盯的是 clearTimeout 这行，不是返回值。
    await expect(withTimeout(Promise.resolve('好了'), 1_000, '渲染')).resolves.toBe('好了');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('task 抛错后定时器也要清掉', async () => {
    await expect(withTimeout(Promise.reject(new Error('坏了')), 1_000, '渲染')).rejects.toThrow(
      '坏了',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('settleWithin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('按时落地就用真结果', async () => {
    await expect(settleWithin(Promise.resolve('真的'), 1_000, '兜底')).resolves.toBe('真的');
  });

  it('超时就用兜底值，不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = settleWithin(never(), 1_000, false, '字体就绪');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(task).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('出错也用兜底值', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settleWithin(Promise.reject(new Error('坏了')), 1_000, 0, '取资源')).resolves.toBe(
      0,
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it('不给 label 就闷声兜底', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settleWithin(Promise.reject(new Error('坏了')), 1_000, 0)).resolves.toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('兜底时用 warn 而不是 error', async () => {
    // e2e 把 console.error 当回归信号，而「字体没等到」只是结果有瑕疵。
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await settleWithin(Promise.reject(new Error('坏了')), 1_000, 0, '取资源');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('fetchWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('2xx 直接返回响应', async () => {
    const response = { ok: true, status: 200 } as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchWithin('http://x/a.css', 1_000, '取样式表')).resolves.toBe(response);
  });

  it('非 2xx 抛错并带上状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response));
    await expect(fetchWithin('http://x/a.css', 1_000, '取样式表')).rejects.toThrow('HTTP 404');
  });

  it('超时就 abort 掉请求，并换成我们自己那句话', async () => {
    vi.useFakeTimers();
    // 真实现里 abort 是浏览器做的；这里照它的约定，signal 一触发就抛 AbortError。
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The user aborted a request.');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    );

    const task = fetchWithin('http://x/a.css', 1_000, '取图片快照用的样式表');
    const assertion = expect(task).rejects.toThrow('取图片快照用的样式表超时（等了 1 秒');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('请求落地后定时器要清掉', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    await fetchWithin('http://x/a.css', 1_000, '取样式表');
    expect(vi.getTimerCount()).toBe(0);
  });
});
