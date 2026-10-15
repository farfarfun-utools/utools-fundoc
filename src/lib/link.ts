// 正文超链接的地址规范化。
//
// 单独拿出来是为了能测：这是一道**安全闸门**，判断结果直接喂给
// `utools.shellOpenExternal`，也就是交给操作系统去「打开」。放错一个协议的代价不是
// 界面难看，而是正文里写一行 Markdown 就能让宿主执行点什么。阈值定得紧一些：
// 不在白名单里的一律当不认识，静默忽略。

/** 放行的协议。
 *
 *  刻意不含 `file:` —— 文档是会跨设备同步的，别人的文档能让你的机器去打开本地路径
 *  是个不该开的口子。也不含 `javascript:` / `data:`（显而易见）。 */
const SAFE_SCHEME = /^(?:https?|mailto):/i;

/** 有没有写协议头。`https://…`、`mailto:a@b.c` 都算。 */
const HAS_SCHEME = /^[a-z][a-z\d+\-.]*:/i;

/**
 * 光秃秃的域名开头，如 `example.com`、`sub.example.co.uk/path?q=1`。
 *
 * Markdown 里 `[文档](example.com/a)` 很常见，按 HTML 的规矩那是相对路径，但作者
 * 想的几乎总是外链。要求至少有一个点、且点两边都有字符，`./a.md` 和 `/abs/path`
 * 都不会命中。
 */
const BARE_DOMAIN = /^[\w-]+(?:\.[\w-]+)+(?=$|[/?#])/;

/**
 * 把正文里的链接地址变成一个可以交给系统浏览器的绝对 URL。
 *
 * @param raw Markdown 里写的原始地址。
 * @returns 可打开的 URL；不该打开的（空、站内锚点、图片附件、相对路径、不认识的协议）返回 null。
 */
export function externalLinkUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  // 站内锚点交给 Vditor 自己的目录跳转；图片附件引用只有本插件认得，丢给浏览器没意义。
  if (text.startsWith('#') || text.startsWith('fundoc-asset:')) return null;

  const url = HAS_SCHEME.test(text)
    ? text
    : BARE_DOMAIN.test(text)
      ? `https://${text}`
      : '';
  return SAFE_SCHEME.test(url) ? url : null;
}
