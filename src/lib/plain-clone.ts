/**
 * 深拷贝可 JSON 序列化的数据，保留空值。
 *
 * 存在的理由只有一个：Vue 的响应式 Proxy 过不了 Electron 的结构化克隆，直接塞给
 * `utools.db.put` 会失败。凡是要写进数据库的对象都得先过这里脱一层响应式。
 *
 * @param value 要复制的普通数据。
 * @returns 与输入值内容相同的新数据；空值原样返回。
 */
export function clonePlain<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}
