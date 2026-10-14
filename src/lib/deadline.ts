// 给「可能永远不返回」的等待加上期限。
//
// 为什么需要这一层：出图和打印那条路上全是 await —— 让 Vditor 渲染、等字体就绪、取样式表、
// 解码 SVG、编码 PNG。其中任何一步永远不落地，界面就会永远停在「正在生成图片…」上：按钮
// 一直禁用，提示四秒后自己消失，剩下的现象就是「插件卡死了，而且没有任何报错」。
//
// 这不是假想。在浏览器里用 CDP 扣住一个 `katex.min.css` 请求不放，出图按钮就永久禁用、
// 离屏容器永久留在页面上，只能重开插件（docs/design.md §8.7）。真机上同样的后果来自
// 更平常的原因：某个本地资源一时读不出来、字体加载卡在 pending 上。
//
// 期限**不会取消**正在进行的工作（fetch 除外 —— 它能 abort）。所以赢了比赛之后，迟到的
// 那份结果必须有人收尾：调用方要么本来就在 finally 里收（snapshotMarkdown 就是），
// 要么确认忽略它不会在页面上留下东西。

/**
 * 超时错误。
 *
 * 消息是**直接给用户看的** —— 出图失败时这句话会原样显示在提示条上，所以写人话、
 * 带上等了多久，而不是 `Error: timeout`。
 *
 * @param label 在等什么，如「生成图片」。
 * @param ms 等了多少毫秒。
 */
export function timeoutError(label: string, ms: number): Error {
  return new Error(`${label}超时（等了 ${Math.round(ms / 1000)} 秒还没有结果）`);
}

/**
 * 等一个 Promise，超时就抛错。
 *
 * @param task 要等的 Promise。
 * @param ms 期限毫秒。
 * @param label 在等什么，进错误消息。
 * @returns task 的结果。
 * @throws 超时，或者 task 自己抛出的错误。
 */
export function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(label, ms)), ms);
    // 不用 Promise.race：定时器要在 task 落地时清掉，否则它会把进程（跑单测时）
    // 和事件循环一直撑着，还会在早就结束的操作上迟到地报一次超时。
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 等一个 Promise，超时或出错就用兜底值。
 *
 * 给「等不到也能往下走」的步骤用：等字体就绪、取一个可选资源。这类步骤卡住时，
 * 正确的反应是**带着瑕疵继续**，而不是把整次操作判死 —— 更不是永远等下去。
 *
 * @param task 要等的 Promise。
 * @param ms 期限毫秒。
 * @param fallback 超时或出错时返回的值。
 * @param label 给了就在落到兜底值时 console.warn 一句，便于事后对账。
 * @returns task 的结果，或者 fallback。
 */
export async function settleWithin<T>(
  task: Promise<T>,
  ms: number,
  fallback: T,
  label?: string,
): Promise<T> {
  try {
    return await withTimeout(task, ms, label ?? '等待');
  } catch (error) {
    // 刻意用 warn 不用 error：这条路上的失败都是「结果有瑕疵」级别的，
    // 而 e2e 把 console.error 当回归。
    if (label) console.warn(`[fundoc] ${label}没等到，继续往下走`, error);
    return fallback;
  }
}

/**
 * 带期限的 fetch。
 *
 * 用 AbortController 而不是只 race 一个定时器：请求挂住时**连接也得断掉**。
 * 浏览器对同一个源只开六条连接，几次挂住之后后面所有请求都排不上队 ——
 * 那时卡住的就不只是出图了。
 *
 * @param url 地址。
 * @param ms 期限毫秒。
 * @param label 在取什么，进错误消息。
 * @returns 响应。
 * @throws 超时、网络失败，或 HTTP 状态不是 2xx。
 */
export async function fetchWithin(url: string, ms: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    // abort 之后 fetch 抛的是 AbortError（消息还是英文的「user aborted a request」），
    // 换成我们自己那句，否则提示条上会出现一句看不懂的话，还像是用户自己点了取消。
    if (error instanceof Error && error.name === 'AbortError') throw timeoutError(label, ms);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
