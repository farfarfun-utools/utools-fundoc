// 字节 ↔ base64。
//
// 两处都要用：浏览器垫片把附件存进 localStorage（只能放字符串），以及导出时把二进制
// 文件递给 preload（跨进程边界传不了 Uint8Array）。放一份共用，免得两边各写一个、
// 其中一个在大文件上栈溢出。
//
// 不用 `String.fromCharCode(...bytes)` 的展开写法：那是按参数个数展开的，
// 几百 KB 的图片就会撞上参数个数上限直接抛错。

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
