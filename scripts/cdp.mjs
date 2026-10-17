// 【生成文件，请勿手改】由 https://github.com/farfarfun-utools/utools-shots 分发到四个
// 插件仓库。要改就回那边改，再跑一遍它的 build-scripts.mjs —— 直接改这里，下次分发就没了
// （这个文件当初就是这么分叉成两种内容的）。
//
// 极简 Chrome DevTools Protocol 客户端。
//
// 为什么不用 Puppeteer / Playwright：它们各自带一份几百 MB 的浏览器下载，而这个项目
// 只需要「开一个页面，跑几句 JS，看有没有报错」。Node 22 自带全局 WebSocket 和 fetch，
// CDP 本身就是 JSON over WebSocket，整件事三百行以内，还不用往 devDependencies 里
// 塞一个比源码大几十倍的依赖。
//
// 浏览器也不下载，用机器上现成的。找不到就让调用方跳过 —— 这套检查是开发期的辅助，
// 不该让没装 Chrome 的环境连测试都跑不起来。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 常见的 Chromium 系浏览器位置。按「专门装的 > 系统自带」排。 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), '.local/bin/chromium'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * 找一个可用的浏览器。
 * @returns 可执行文件路径；没找到返回 null。
 */
export function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单条 CDP 命令的期限。给得宽：正常都是毫秒级，这个数只用来兜「永远不回复」。 */
const COMMAND_TIMEOUT = 30_000;
/** 探一次调试端口的期限。它卡住过（见 connect()），所以每次探测都得能自己放弃。 */
const PROBE_TIMEOUT = 2_000;

/**
 * 等某个条件成立。
 * @param probe 返回真值即成立，可以是异步的。
 * @param options.timeout 上限毫秒。
 * @param options.interval 轮询间隔。
 * @param options.label 超时报错里的描述。
 * @returns probe 的返回值。
 */
export async function waitFor(probe, { timeout = 15_000, interval = 100, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

/** 一条 CDP 连接（这里只开页面级会话，用不上 Target 那套转发）。 */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
    });

    // 浏览器先挂掉时，所有在飞的请求都得立刻失败，否则整个脚本卡在 await 上。
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  /**
   * 发一条 CDP 命令。
   * @param method 形如 `Runtime.evaluate`。
   * @param params 参数对象。
   * @returns 命令结果。
   */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // 必须带期限。上面那个 close 监听只管得了「浏览器挂了」，而它还有一种半死不活的状态：
      // 进程在、连接开着，命令却永远不回复。那时整条命令挂死，没有任何输出可看。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, COMMAND_TIMEOUT);
      const settle = (run) => (value) => {
        clearTimeout(timer);
        run(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 订阅事件。
   * @param method 事件名，如 `Runtime.consoleAPICalled`。
   * @param handler 回调。
   */
  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  /**
   * 在页面里求值。
   *
   * 一律 `returnByValue` + `awaitPromise`：返回的东西要能跨进程带回来，所以只能是
   * 可 JSON 化的值 —— 想看 DOM 就在表达式里自己转成字符串或布尔。
   *
   * @param expression JS 表达式。
   * @returns 求值结果。
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? '页面内求值失败');
    }
    return result.result.value;
  }

  /**
   * 等页面里的表达式变成真值。
   * @param expression JS 表达式。
   * @param options 见 waitFor。
   */
  waitForExpression(expression, options = {}) {
    return waitFor(() => this.evaluate(expression), { label: expression, ...options });
  }
}

/**
 * 启动浏览器并连上第一个页面。
 *
 * 用 `--remote-debugging-port=0` 让系统分配端口，再从 user-data-dir 里的
 * DevToolsActivePort 文件读回来 —— 固定端口在并行跑的时候会撞车。
 *
 * @param options.url 要打开的地址。返回后自己调一次 navigate() 才会真的跳过去。
 * @param options.binary 浏览器可执行文件；默认自动寻找。
 * @param options.headless 是否无头。调试时传 false 能看见界面。
 * @param options.downloadPath 下载目录。给了就允许下载并落到这里。
 * @returns 会话对象和 close()。
 */
export async function launch({ url, binary = findBrowser(), headless = true, downloadPath } = {}) {
  if (!binary) throw new Error('找不到 Chromium 系浏览器');

  // 前缀不带插件名：这个文件由 build-scripts.mjs 分发到四个仓库，带名字的话每个仓库
  // 都会想改成自己的名字，然后四份就各走各的了。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'utools-cdp-'));

  /**
   * 拉起浏览器，等它把调试端口写出来。
   * @param extra 额外命令行参数。
   * @returns 进程、端口和一个「已退出」的查询函数。
   */
  async function start(extra = []) {
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      // 无头 Chrome 默认不给 GPU，禁掉能少一堆与本测试无关的告警。
      '--disable-gpu',
      '--window-size=1280,900',
      ...extra,
    ];
    if (headless) args.push('--headless=new');
    // 刻意**不**在命令行上给地址：那样页面在我们连上之前就开始加载了，Network.enable
    // 之前发出的请求全都收不到，「有没有回落 CDN」这类检查会时灵时不灵。
    // 统一先开 about:blank，等各域都 enable 完再 Page.navigate 过去。
    args.push('about:blank');

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const state = { exited: false };
    child.on('exit', () => {
      state.exited = true;
    });

    const portFile = path.join(profile, 'DevToolsActivePort');
    const readPort = () => {
      if (state.exited) {
        const error = new Error(`浏览器启动失败：\n${stderr.join('')}`);
        error.stderr = stderr.join('');
        throw error;
      }
      if (!fs.existsSync(portFile)) return null;
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      return first ? Number(first) : null;
    };

    const port = await waitFor(readPort, { label: 'DevToolsActivePort', timeout: 30_000 });
    return { child, port, state };
  }

  let started;
  try {
    started = await start();
  } catch (error) {
    // 容器和开了 AppArmor userns 限制的发行版（Ubuntu 23.10+）里 Chromium 起不来沙箱。
    // **只在确认是这个原因时**才补 --no-sandbox，而不是默认就带上：这里加载的虽然只是
    // 本机静态服务器上我们自己的产物，但关沙箱是降低安全边界的事，得有明确理由。
    if (!/No usable sandbox|Failed to move to new namespace/.test(error.stderr ?? '')) throw error;
    console.warn('[cdp] 当前系统不允许 Chromium 沙箱，改用 --no-sandbox 重试');
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    started = await start(['--no-sandbox']);
  }

  const { child, port, state } = started;
  const exited = () => state.exited;

  /** 收掉浏览器进程和临时 profile。启动中途失败和正常 close 都走这里。 */
  async function teardown() {
    if (!exited()) {
      child.kill('SIGTERM');
      // 给它一点时间自己退，不然 user-data-dir 删不干净。
      for (let i = 0; i < 30 && !exited(); i += 1) await sleep(100);
      if (!exited()) child.kill('SIGKILL');
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }

  /** 连上页面并把要用的域打开。失败时负责把浏览器收掉再把错误抛出去。 */
  async function connect() {
    // 页面 target 在端口就绪后还要一小会儿才出现。
    //
    // 每次探测都带 abort：headless Chromium 偶尔会在启动中途卡住 —— 端口听着、TCP 也接了，
    // 但这个请求永远不回。node 的 fetch 没有默认超时，而 waitFor 只在两次探测**之间**看期限，
    // 于是整条命令挂死（实测两次，一次十分钟一次十一分钟，都是连一行检查结果都没打出来）。
    // 探测失败当成「还没就绪」继续轮询，真到点了由 waitFor 报超时。
    const target = await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT),
          });
          const list = await response.json();
          return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
        } catch {
          return null;
        }
      },
      { label: '页面 target' },
    );

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    // 这里必须带超时。`open` 和 `error` 之外还有第三种结局：浏览器偶尔在启动中途卡住，
    // 调试端口已经写出来、target 也列得出来，但这条连接既不开也不报错 —— 实测卡了十分钟
    // 还在等。上面每个等待都有上限，当时只有这里没有，于是整个脚本永远不返回。
    // 报一句话好过挂死：这是开发期命令，重跑一遍通常就好了。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15_000);
      const settle = (run) => () => {
        clearTimeout(timer);
        run();
      };
      socket.addEventListener('open', settle(resolve), { once: true });
      socket.addEventListener(
        'error',
        settle(() => reject(new Error('CDP WebSocket 连接失败'))),
        { once: true },
      );
    });

    const session = new Session(socket);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Network.enable');
    await session.send('Log.enable');

    if (downloadPath) {
      fs.mkdirSync(downloadPath, { recursive: true });
      // Browser 域在页面连接上也能用；个别版本只认已废弃的 Page 版本，所以兜一层。
      await session
        .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
        .catch(() => session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath }));
    }

    return { session, socket };
  }

  let connected;
  try {
    connected = await connect();
  } catch (error) {
    // 连不上就别把浏览器和 profile 留在机器上 —— 调用方拿不到 close()，没人收。
    await teardown();
    throw error;
  }
  const { session, socket } = connected;

  return {
    session,
    port,
    /**
     * 打开页面。
     *
     * 由调用方在挂好事件监听之后调用，而不是在这里顺手跳过去 —— 页面一加载就会冒出一串
     * Network 事件，这时候监听还没挂上就全漏了。
     *
     * @param to 目标地址，默认是 launch 时传的那个。
     */
    navigate: (to = url) => session.send('Page.navigate', { url: to }),
    async close() {
      try {
        socket.close();
      } catch {
        // 连接可能已经断了，忽略。
      }
      await teardown();
    },
  };
}
