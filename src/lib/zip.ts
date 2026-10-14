// 最小 ZIP 打包器：只做 store（不压缩）。
//
// 为什么要自己写：浏览器预览里没有 Node 的 fs，导出一棵文档树只能给用户一个文件，
// 而「一个文件」里要装多篇 .md 和一堆图片，就只能是压缩包。引一个 JSZip 进来是
// 300 KB 依赖换 60 行代码的事 —— 而且 store 模式的 ZIP 格式本身没有歧义空间。
//
// 不做压缩是刻意的：deflate 得自己实现或者引 pako，而 Markdown 文档的体量下，
// 压缩省的那点空间远不值一个新依赖。解压工具不在乎 —— store 是标准的一部分。
//
// 真机上不走这条路：那边有 fs，直接写成真的目录结构，用户能直接编辑。

/** CRC-32（IEEE 802.3）查表。浏览器里没有现成实现，Node 的 zlib.crc32 也带不过来。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 算一段字节的 CRC-32。
 * @param bytes 输入字节。
 * @returns 无符号 32 位结果。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = {
  /** 包内路径，用 `/` 分隔。以 `/` 结尾表示目录条目。 */
  path: string;
  /** 目录条目传空。 */
  bytes?: Uint8Array;
};

/** DOS 时间戳。2 秒精度是格式本身的限制，不是这里偷懒。 */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    // ZIP 的纪元是 1980；比这更早的时间没法表示，统一压到 1980-01-01。
    date:
      (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 顺序写入的小字节缓冲。长度一开始就能算准，所以不需要动态扩容。 */
class Writer {
  private readonly view: DataView;
  private offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, true); // ZIP 全程小端
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  raw(data: Uint8Array): void {
    this.bytes.set(data, this.offset);
    this.offset += data.length;
  }
}

/**
 * 把一组条目打成 ZIP（store 模式）。
 *
 * @param entries 条目清单，顺序即包内顺序。目录条目 path 以 `/` 结尾、不带字节。
 * @param now 时间戳，便于测试固定输出。
 * @returns 完整 ZIP 字节。
 */
export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  const prepared = entries.map((entry) => {
    const bytes = entry.bytes ?? new Uint8Array(0);
    return { name: encoder.encode(entry.path), bytes, crc: crc32(bytes) };
  });

  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;
  const localSize = prepared.reduce(
    (sum, item) => sum + LOCAL_HEADER + item.name.length + item.bytes.length,
    0,
  );
  const centralSize = prepared.reduce((sum, item) => sum + CENTRAL_HEADER + item.name.length, 0);

  const writer = new Writer(new Uint8Array(localSize + centralSize + EOCD));

  // 文件名一律按 UTF-8 写，并置通用标志位 11 告诉解压工具这件事。
  // 不置这一位的话，中文名在 Windows 自带解压里会按本地代码页解释，变成乱码。
  const UTF8_FLAG = 0x0800;
  const VERSION = 20; // 2.0：store + 目录条目所需的最低版本

  const offsets: number[] = [];
  for (const item of prepared) {
    offsets.push(writer.position);
    writer.u32(0x04034b50);
    writer.u16(VERSION);
    writer.u16(UTF8_FLAG);
    writer.u16(0); // 压缩方式 0 = store
    writer.u16(time);
    writer.u16(date);
    writer.u32(item.crc);
    writer.u32(item.bytes.length); // store 下压缩前后一样大
    writer.u32(item.bytes.length);
    writer.u16(item.name.length);
    writer.u16(0); // extra field
    writer.raw(item.name);
    writer.raw(item.bytes);
  }

  const centralStart = writer.position;
  for (const [index, item] of prepared.entries()) {
    const isDir = item.name[item.name.length - 1] === 0x2f; // '/'
    writer.u32(0x02014b50);
    writer.u16(VERSION);
    writer.u16(VERSION);
    writer.u16(UTF8_FLAG);
    writer.u16(0);
    writer.u16(time);
    writer.u16(date);
    writer.u32(item.crc);
    writer.u32(item.bytes.length);
    writer.u32(item.bytes.length);
    writer.u16(item.name.length);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // 起始磁盘号
    writer.u16(0); // 内部属性
    // 外部属性高 16 位是 Unix 权限。目录标成 drwxr-xr-x、文件标成 -rw-r--r--，
    // 并给目录补上 MS-DOS 的目录位（0x10）—— 少了它，有些解压工具会把目录当空文件。
    writer.u32(isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0);
    writer.u32(offsets[index]);
    writer.raw(item.name);
  }

  writer.u32(0x06054b50);
  writer.u16(0); // 本磁盘号
  writer.u16(0); // 中央目录所在磁盘号
  writer.u16(prepared.length);
  writer.u16(prepared.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // 注释长度

  return writer.bytes;
}
