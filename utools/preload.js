const fs = require('fs')
const path = require('path')

// 打分与路径拼接的唯一实现，由 vite.preload.config.ts 从 src/lib/search.ts 打出来。
// 加载失败时降级成「只搜标题」而不是让整个 preload 崩掉 —— preload 抛异常会连
// window.fundoc 一起带走，那会让读取文件、mainPush 跳转这些毫不相干的功能一起失效。
let searchCore = null
try {
  searchCore = require('./search-core.cjs')
} catch (error) {
  console.error('[fundoc] search-core.cjs 加载失败，主搜索框退化为只搜标题', error)
}

// 和 src/lib/storage.ts 里的常量保持一致。
const META_PREFIX = 'meta@'
const PENDING_KEY = 'fundoc.pending-open'
// 超过这个时间的待打开记录一律丢弃。dbStorage 会跨设备同步，不加时效的话，
// 另一台机器上几天前的一次搜索可能在本机触发一次莫名其妙的跳转。
const PENDING_TTL = 30 * 1000
const MAX_RESULTS = (searchCore && searchCore.DEFAULT_LIMIT) || 8

/** 读出全部节点元数据（含目录 —— 拼路径要用）。 */
function allMetas() {
  return utools.db.allDocs(META_PREFIX).filter(doc => typeof doc.nodeId === 'string')
}

/**
 * 正文读取器（带缓存、自带「查询太短就不读」的判断）。
 *
 * 实现和界面那边是同一份（src/lib/search.ts）—— 两边各写一个缓存，迟早一边忘记失效。
 */
const bodyReader = searchCore ? searchCore.createBodyReader(utools.db) : null

/** 退化实现：search-core 没加载成功时只按标题前缀/包含匹配。 */
function fallbackSearch(metas, query) {
  const word = query.trim().toLowerCase()
  if (!word) return []
  return metas
    .filter(meta => meta.type === 'doc' && (meta.name || '').toLowerCase().includes(word))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RESULTS)
    .map(meta => ({ nodeId: meta.nodeId, name: meta.name || '未命名文档', path: meta.name || '', snippet: '' }))
}

/**
 * 上一次推送出去的结果：text → nodeId。
 *
 * onSelect 只回传 `option.text`（也就是文档名），`MainPushResult` 挂不了自定义载荷。
 * 重新按名字找会在同名文档上挑错篇，所以这里把上一次的对应关系记下来，
 * 让「用户看到的那条」和「真正打开的那篇」严格一致。
 */
let lastResults = new Map()

utools.onMainPush(
  ({ payload }) => {
    const query = String(payload || '').trim()
    if (!query) return []

    const metas = allMetas()
    const metaById = new Map(metas.map(meta => [meta.nodeId, meta]))
    const hits = searchCore
      ? searchCore.searchDocs(metas, query, {
          limit: MAX_RESULTS,
          // 查询太短时 forQuery 返回 undefined，searchDocs 就完全不碰正文。
          bodyOf: bodyReader.forQuery(query, metaById),
        })
      : fallbackSearch(metas, query)

    // 同名文档必须显示成不同的 text。`option.text` 是 onSelect 唯一能拿到的线索，
    // 两条都叫「周报」的话，用户点第二条也只会打开第一条 —— 而且看不出哪里不对。
    // 重名时退化成完整路径，路径也一样再编号。
    const used = new Set()
    const textFor = hit => {
      const base = used.has(hit.name) ? hit.path || hit.name : hit.name
      let candidate = base
      let counter = 2
      while (used.has(candidate)) candidate = `${base} (${counter++})`
      used.add(candidate)
      return candidate
    }

    lastResults = new Map()
    return hits.map(hit => {
      const text = textFor(hit)
      lastResults.set(text, hit.nodeId)
      return {
        icon: 'logo.png',
        text,
        // title 里放完整路径。命中正文时换成正文片段，让用户看见自己搜的词出现在哪儿 ——
        // 否则一条「标题完全不相关」的结果没法理解。
        title: hit.snippet ? `${hit.path} · ${hit.snippet}` : `落笔成章 · ${hit.path}`,
      }
    })
  },
  action => {
    const selected = action.option && action.option.text
    if (!selected) return true

    let nodeId = lastResults.get(selected)
    if (!nodeId) {
      // 兜底：进程重启或推送结果已被覆盖时按名字找，同名取最近更新的那篇。
      const sameName = allMetas()
        .filter(meta => meta.type === 'doc' && (meta.name || '未命名文档') === selected)
        .sort((left, right) => right.updatedAt - left.updatedAt)
      nodeId = sameName.length ? sameName[0].nodeId : null
    }

    if (nodeId) utools.dbStorage.setItem(PENDING_KEY, { nodeId, at: Date.now() })
    return true
  }
)

window.fundoc = {
  readTextFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      console.error('[fundoc] 读取文件失败', filePath, error)
      return null
    }
  },

  takePendingOpen() {
    const pending = utools.dbStorage.getItem(PENDING_KEY)
    if (!pending) return null
    utools.dbStorage.removeItem(PENDING_KEY)
    if (Date.now() - (pending.at || 0) > PENDING_TTL) return null
    return pending.nodeId || null
  },

  /**
   * 在 `parentDir` 下建出 `rootName` 目录，并把一批文件写进去。
   *
   * 路径拼接刻意全放在 Node 侧：渲染进程里没有 `path`，自己拿 `/` 拼在 Windows 上要出问题。
   *
   * @param {string} parentDir 用户选的父目录（绝对路径）。
   * @param {string} rootName 导出根目录名（单段，不含分隔符）。
   * @param {string[]} dirs 需要预先建出来的相对目录，自上而下。
   * @param {Array<{path: string, text?: string, base64?: string}>} files 待写文件。
   * @returns {{ ok: true, root: string } | { ok: false, message: string }}
   */
  writeFiles(parentDir, rootName, dirs, files) {
    try {
      // rootName 来自文档名，已经洗过一遍。这里再挡一次：带分隔符就会跳出用户选的目录。
      if (!rootName || path.basename(rootName) !== rootName) {
        throw new Error(`导出目录名不合法：${rootName}`)
      }
      const rootDir = path.resolve(parentDir, rootName)

      // 相对路径里带 `..` 会把文件写到导出目录外面去。路径是我们自己生成的，
      // 但写错地方不可逆，这道防线不花钱。
      const safeJoin = relative => {
        const target = path.resolve(rootDir, relative)
        if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
          throw new Error(`拒绝写到导出目录外：${relative}`)
        }
        return target
      }

      fs.mkdirSync(rootDir, { recursive: true })
      for (const relative of dirs) fs.mkdirSync(safeJoin(relative), { recursive: true })
      for (const file of files) {
        const target = safeJoin(file.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (typeof file.text === 'string') fs.writeFileSync(target, file.text, 'utf8')
        else fs.writeFileSync(target, Buffer.from(file.base64 || '', 'base64'))
      }
      return { ok: true, root: rootDir }
    } catch (error) {
      console.error('[fundoc] 导出写入失败', error)
      return { ok: false, message: (error && error.message) || '写入失败' }
    }
  },

  /**
   * 写单个文本文件到指定绝对路径（用户在保存对话框里选好的那个）。
   * @param {string} filePath 目标文件绝对路径。
   * @param {string} text 文件内容。
   * @returns {{ ok: true, root: string } | { ok: false, message: string }}
   */
  writeTextFile(filePath, text) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, text, 'utf8')
      return { ok: true, root: filePath }
    } catch (error) {
      console.error('[fundoc] 导出写入失败', filePath, error)
      return { ok: false, message: (error && error.message) || '写入失败' }
    }
  },

  /**
   * 写单个二进制文件到指定绝对路径（导出的 PNG 走这条）。
   *
   * 字节用 base64 传而不是 Uint8Array：跨 preload 边界的类型化数组到了 Node 侧
   * 不保证还是同一种视图，base64 是两边都没有歧义的形态。
   *
   * @param {string} filePath 目标文件绝对路径。
   * @param {string} base64 文件内容的 base64 编码。
   * @returns {{ ok: true, root: string } | { ok: false, message: string }}
   */
  writeBinaryFile(filePath, base64) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, Buffer.from(base64 || '', 'base64'))
      return { ok: true, root: filePath }
    } catch (error) {
      console.error('[fundoc] 导出写入失败', filePath, error)
      return { ok: false, message: (error && error.message) || '写入失败' }
    }
  },

  /** 在系统文件管理器里定位导出结果。 */
  showInFolder(target) {
    try {
      utools.shellShowItemInFolder(target)
    } catch (error) {
      console.error('[fundoc] 打开目录失败', target, error)
    }
  },
}
