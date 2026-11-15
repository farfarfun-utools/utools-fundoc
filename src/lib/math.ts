/** Let Vditor render LaTeX display delimiters it does not parse itself. */
export function renderMathDelimiters(markdown: string): string {
  // shortcut: 只识别独占行的展示公式；需要段落内写法时改用 Markdown token 解析。
  const lines = markdown.split('\n');
  let fence: { marker: string; length: number } | null = null;
  let open = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open < 0) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { marker: marker[0], length: marker.length };
        else if (marker[0] === fence.marker && marker.length >= fence.length &&
          line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = null;
        continue;
      }
      if (fence || !/^ {0,3}\\\[/.test(line)) continue;
      open = i;
    }

    const end = lines[i].lastIndexOf('\\]');
    if (end < 0 || lines[i].slice(end + 2).trim()) continue;
    lines[open] = lines[open].replace(/^( {0,3})\\\[/, (_, indent: string) => `${indent}$$`);
    lines[i] = lines[i].slice(0, end) + '$$' + lines[i].slice(end + 2);
    open = -1;
  }

  return lines.join('\n');
}
