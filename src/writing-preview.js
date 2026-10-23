// Deliberately render a small Markdown subset using DOM text nodes only.
// Raw HTML and media remain text; previewing writing never requests external images.
function inline(parent, source, doc) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|!?\[[^\]\n]+\]\([^\s)]+\))/g
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    parent.append(doc.createTextNode(source.slice(offset, match.index)))
    const value = match[0]
    if (value.startsWith('`')) {
      const code = doc.createElement('code'); code.textContent = value.slice(1, -1); parent.append(code)
    } else if (value.startsWith('**') || value.startsWith('__')) {
      const strong = doc.createElement('strong'); strong.textContent = value.slice(2, -2); parent.append(strong)
    } else if (value.startsWith('*')) {
      const em = doc.createElement('em'); em.textContent = value.slice(1, -1); parent.append(em)
    } else {
      const link = /^(!?)\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      if (!link[1] && /^(https?:\/\/|mailto:)/i.test(link[3])) {
        const anchor = doc.createElement('a'); anchor.textContent = link[2]; anchor.href = link[3]; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor)
      } else parent.append(doc.createTextNode(link[1] ? `[图片：${link[2]}]` : value))
    }
    offset = match.index + value.length
  }
  parent.append(doc.createTextNode(source.slice(offset)))
}

export function renderWritingPreview(host, text, doc = host.ownerDocument || document) {
  const fragment = doc.createDocumentFragment()
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  const appendText = (tag, content) => { const node = doc.createElement(tag); inline(node, content, doc); fragment.append(node); return node }
  const tableRow = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index += 1; continue }
    if (/^\s*```/.test(line)) {
      const codeLines = []; index += 1
      while (index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index++])
      const pre = doc.createElement('pre'), code = doc.createElement('code'); code.textContent = codeLines.join('\n'); pre.append(code); fragment.append(pre); index += 1; continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) { appendText(`h${heading[1].length}`, heading[2]); index += 1; continue }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { fragment.append(doc.createElement('hr')); index += 1; continue }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '') && tableRow(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const wrapper = doc.createElement('div'); wrapper.className = 'writing-table-scroll'
      const table = doc.createElement('table'), thead = doc.createElement('thead'), tr = doc.createElement('tr')
      tableRow(line).forEach(cell => { const th = doc.createElement('th'); inline(th, cell, doc); tr.append(th) }); thead.append(tr); table.append(thead); index += 2
      const body = doc.createElement('tbody')
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = doc.createElement('tr'); tableRow(lines[index++]).forEach(cell => { const td = doc.createElement('td'); inline(td, cell, doc); row.append(td) }); body.append(row)
      }
      table.append(body); wrapper.append(table); fragment.append(wrapper); continue
    }
    const listMatch = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line)
    if (listMatch) {
      const ordered = !listMatch[1], list = doc.createElement(ordered ? 'ol' : 'ul')
      while (index < lines.length) {
        const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(lines[index])
        if (!item || Boolean(!item[1]) !== ordered) break
        const li = doc.createElement('li'); inline(li, item[2], doc); list.append(li); index += 1
      }
      fragment.append(list); continue
    }
    if (/^>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''))
      appendText('blockquote', quote.join('\n')); continue
    }
    const paragraph = [line]; index += 1
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s|>\s?|\s*```|\s*[-+*]\s|\s*\d+[.)]\s)/.test(lines[index])) {
      if (lines[index].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) break
      paragraph.push(lines[index++])
    }
    appendText('p', paragraph.join('\n'))
  }
  if (!String(text || '').trim()) { const empty = doc.createElement('p'); empty.className = 'writing-preview-empty'; empty.textContent = '暂无内容。切换到编辑开始创作。'; fragment.append(empty) }
  host.replaceChildren(fragment)
}
