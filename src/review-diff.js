// Exact line tokens retain whitespace and line endings. The LCS budget applies
// across every segment; large edits use unique-line anchors, then a whole-block
// replacement when there is no reliable anchor. Memory stays linear in input
// size plus at most MAX_CELLS integers, even for unrelated large documents.
const MAX_CELLS = 250000
const MAX_DEPTH = 12
const PREVIEW_LINES = 160
const PREVIEW_CHARACTERS = 16000
const LINE_CHARACTERS = 1600

const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) || []

function uniqueAnchors(before, after, a, endA, b, endB) {
  const left = new Map(), right = new Map()
  for (let i = a; i < endA; i++) left.set(before[i], left.has(before[i]) ? -1 : i)
  for (let i = b; i < endB; i++) right.set(after[i], right.has(after[i]) ? -1 : i)
  const candidates = []
  for (const [line, index] of left) {
    const other = right.get(line)
    if (index !== -1 && other !== undefined && other !== -1) candidates.push([index, other])
  }
  // Longest increasing sequence of the right-hand indices, in O(n log n).
  const tails = [], previous = new Int32Array(candidates.length).fill(-1)
  for (let i = 0; i < candidates.length; i++) {
    let low = 0, high = tails.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (candidates[tails[mid]][1] < candidates[i][1]) low = mid + 1
      else high = mid
    }
    if (low) previous[i] = tails[low - 1]
    tails[low] = i
  }
  const result = []
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i]) result.push(candidates[i])
  return result.reverse()
}

export function diffText(before, after, { maxCells = MAX_CELLS } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('差异审阅需要两份文字内容')
  const left = linesOf(before), right = linesOf(after), runs = []
  let cellsRemaining = Number.isSafeInteger(maxCells) && maxCells >= 0 ? Math.min(maxCells, MAX_CELLS) : MAX_CELLS
  let limited = false
  const append = (type, line) => {
    if (runs.at(-1)?.type !== type) runs.push({ type, lines: [] })
    runs.at(-1).lines.push(line)
  }
  const appendRange = (type, source, start, end) => {
    for (let index = start; index < end; index++) append(type, source[index])
  }
  function compare(a, endA, b, endB, depth) {
    while (a < endA && b < endB && left[a] === right[b]) { append('equal', left[a]); a++; b++ }
    let suffix = 0
    while (a < endA - suffix && b < endB - suffix && left[endA - suffix - 1] === right[endB - suffix - 1]) suffix++
    const lastA = endA - suffix, lastB = endB - suffix
    const rows = lastA - a, columns = lastB - b, cells = (rows + 1) * (columns + 1)
    if (!rows || !columns) {
      appendRange('remove', left, a, lastA)
      appendRange('add', right, b, lastB)
    } else if (cells <= cellsRemaining) {
      cellsRemaining -= cells
      const width = columns + 1, lengths = new Uint32Array(cells)
      for (let i = rows - 1; i >= 0; i--) {
        for (let j = columns - 1; j >= 0; j--) {
          lengths[i * width + j] = left[a + i] === right[b + j]
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
        }
      }
      let i = 0, j = 0
      while (i < rows && j < columns) {
        if (left[a + i] === right[b + j]) { append('equal', left[a + i]); i++; j++ }
        else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) append('remove', left[a + i++])
        else append('add', right[b + j++])
      }
      appendRange('remove', left, a + i, lastA)
      appendRange('add', right, b + j, lastB)
    } else {
      const anchors = depth < MAX_DEPTH ? uniqueAnchors(left, right, a, lastA, b, lastB) : []
      if (anchors.length) {
        for (const [nextA, nextB] of anchors) {
          compare(a, nextA, b, nextB, depth + 1)
          append('equal', left[nextA])
          a = nextA + 1; b = nextB + 1
        }
        compare(a, lastA, b, lastB, depth + 1)
      } else {
        limited = true
        appendRange('remove', left, a, lastA)
        appendRange('add', right, b, lastB)
      }
    }
    appendRange('equal', left, lastA, endA)
  }
  compare(0, left.length, 0, right.length, 0)
  const hunks = []
  let oldLine = 1, newLine = 1, added = 0, removed = 0
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    if (run.type === 'equal') { oldLine += run.lines.length; newLine += run.lines.length; continue }
    const contextBefore = runs[index - 1]?.type === 'equal' ? runs[index - 1].lines.slice(-2) : []
    const hunk = { beforeStart: oldLine - contextBefore.length, afterStart: newLine - contextBefore.length, runs: [], added: 0, removed: 0 }
    if (contextBefore.length) hunk.runs.push({ type: 'equal', lines: contextBefore })
    while (index < runs.length && runs[index].type !== 'equal') {
      const changed = runs[index++]
      hunk.runs.push(changed)
      if (changed.type === 'add') { hunk.added += changed.lines.length; newLine += changed.lines.length }
      else { hunk.removed += changed.lines.length; oldLine += changed.lines.length }
    }
    if (runs[index]?.type === 'equal') hunk.runs.push({ type: 'equal', lines: runs[index].lines.slice(0, 2) })
    added += hunk.added; removed += hunk.removed
    hunks.push(hunk)
    index--
  }
  return { runs, hunks, added, removed, limited }
}

// A read-only, reusable review surface. It never changes the source or offers
// partial application. Callers own the original snapshot and atomic apply gate.
export function createReviewDiff({ before, after, title = '文字修改差异', beforeLabel = '改动前', afterLabel = '改动后', documentRef = globalThis.document }) {
  const diff = diffText(before, after)
  const element = (tag, className, text) => {
    const node = documentRef.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const root = element('section', 'review-diff')
  root.setAttribute('aria-label', title)
  const header = element('div', 'review-diff-header')
  header.append(element('strong', 'review-diff-summary', diff.hunks.length ? `${diff.hunks.length} 处变更 · 新增 ${diff.added} 行 · 删除 ${diff.removed} 行` : '文字一致，没有改动'))
  root.append(header)
  if (diff.limited) root.append(element('p', 'review-diff-note', '内容较长，部分区域按整段替换显示；增删行数包含该区域中的未变行。全文完整保留，可在下方展开核对。'))
  if (diff.hunks.length) {
    const controls = element('div', 'review-diff-controls')
    const previous = element('button', '', '上一处'), next = element('button', '', '下一处')
    previous.type = next.type = 'button'
    previous.setAttribute('aria-label', '跳到上一处变更'); next.setAttribute('aria-label', '跳到下一处变更')
    const position = element('span', 'review-diff-position')
    position.setAttribute('role', 'status'); position.setAttribute('aria-live', 'polite'); position.setAttribute('aria-atomic', 'true')
    controls.append(previous, position, next); header.append(controls)
    const legend = element('p', 'review-diff-legend', `− ${beforeLabel}　+ ${afterLabel}　· 保留内容；↵ 表示换行，∎ 表示文末无换行`)
    const content = element('div', 'review-diff-hunk')
    content.tabIndex = -1; content.setAttribute('role', 'region')
    root.append(legend, content)
    let current = 0
    function show(index, focus = false) {
      current = index
      const hunk = diff.hunks[index]
      position.textContent = `第 ${index + 1} / ${diff.hunks.length} 处`
      previous.disabled = index === 0; next.disabled = index === diff.hunks.length - 1
      content.setAttribute('aria-label', `第 ${index + 1} 处变更，新增 ${hunk.added} 行，删除 ${hunk.removed} 行`)
      content.replaceChildren()
      const location = element('p', 'review-diff-location', `${beforeLabel}第 ${hunk.beforeStart} 行起 → ${afterLabel}第 ${hunk.afterStart} 行起`)
      content.append(location)
      let oldLine = hunk.beforeStart, newLine = hunk.afterStart, shown = 0, characters = 0, omitted = 0, clipped = false
      for (const run of hunk.runs) {
        for (const line of run.lines) {
          const oldNumber = run.type === 'add' ? '' : oldLine++
          const newNumber = run.type === 'remove' ? '' : newLine++
          if (shown >= PREVIEW_LINES || characters >= PREVIEW_CHARACTERS) { omitted++; continue }
          const row = element('div', `review-diff-line review-diff-${run.type}`)
          const label = run.type === 'add' ? '新增' : run.type === 'remove' ? '删除' : '保留'
          const numbers = element('span', 'review-diff-numbers', `${oldNumber || '—'} / ${newNumber || '—'}`)
          numbers.setAttribute('aria-hidden', 'true')
          const sign = element('span', 'review-diff-sign', run.type === 'add' ? '+' : run.type === 'remove' ? '−' : '·')
          sign.setAttribute('aria-hidden', 'true')
          const accessibleLabel = element('span', 'review-diff-sr-only', `${label}，${beforeLabel} ${oldNumber || '无'} 行，${afterLabel} ${newNumber || '无'} 行：`)
          const eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
          const text = eol ? line.slice(0, -eol.length) : line
          const cap = Math.min(LINE_CHARACTERS, PREVIEW_CHARACTERS - characters)
          const truncated = text.length > cap
          const body = element('span', 'review-diff-text', text.slice(0, cap) + (truncated ? '…〔本行较长，全文见下方〕' : ''))
          characters += Math.min(text.length, cap); clipped ||= truncated
          const ending = element('span', 'review-diff-ending', eol ? eol === '\r\n' ? '↵ CRLF' : '↵' : '∎')
          ending.setAttribute('aria-label', eol ? eol === '\r\n' ? 'Windows 换行' : '换行' : '文末无换行')
          if (!text.trim()) {
            const whitespace = text ? `空白行（${text.length} 个空白字符）` : '空行'
            body.append(element('span', 'review-diff-whitespace', whitespace))
          }
          row.append(numbers, sign, accessibleLabel, body, ending); content.append(row); shown++
        }
      }
      if (omitted || clipped) content.append(element('p', 'review-diff-note', `${omitted ? `本处还有 ${omitted} 行未在预览中展示。` : ''}${clipped ? '长行已缩略。' : ''}请展开下方全文查看完整内容；采纳仍使用完整内容。`))
      if (focus) { content.scrollTop = 0; content.focus({ preventScroll: true }); content.scrollIntoView?.({ block: 'nearest' }) }
    }
    previous.addEventListener('click', () => { if (current > 0) show(current - 1, true) })
    next.addEventListener('click', () => { if (current < diff.hunks.length - 1) show(current + 1, true) })
    show(0)
  }
  const full = element('details', 'review-diff-full'), summary = element('summary', '', `查看全文 · ${beforeLabel} ${before.length} 字符 / ${afterLabel} ${after.length} 字符`)
  full.append(summary)
  let expanded = false
  full.addEventListener('toggle', () => {
    if (!full.open || expanded) return
    expanded = true
    for (const [label, text] of [[beforeLabel, before], [afterLabel, after]]) {
      const heading = element('h5', '', label), body = element('pre', 'review-diff-full-text', text || '（空白内容）')
      body.tabIndex = 0; body.setAttribute('aria-label', `${label}全文`)
      full.append(heading, body)
    }
  })
  root.append(full)
  return root
}
