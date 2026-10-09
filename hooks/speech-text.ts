// Markdown as Claude writes it, turned into what is worth hearing: the prose
// kept, the marks dropped, and what cannot be read aloud (code, tables, links)
// named in a word.

const TERMINAL = /[.!?:;,…]$/

const basename = (path: string): string => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut < 0 ? path : path.slice(cut + 1)
}

// A path of two folders or more is its file's name; `name.ts:42` is a line.
const sayPaths = (text: string): string =>
  text
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}[\\/]?|(?:[\w.@~-]+[\\/]){2,}[\w.@~-]*/g, path =>
      basename(path.replace(/[\\/]$/, '')),
    )
    .replace(/(\.[A-Za-z]{1,5}):(\d+)(?::\d+)?\b/g, '$1 line $2')

// A heading or a list item is a sentence of its own: its mark goes, and
// `closed` gives it the stop that makes the voice pause.
const isOwnSentence = (line: string): boolean =>
  /^\s{0,3}#{1,6}\s/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)

const unmarked = (line: string): string =>
  line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')

const closed = (said: string): string => (said !== '' && !TERMINAL.test(said) ? `${said}.` : said)

const sayInline = (text: string): string =>
  sayPaths(
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<https?:\/\/[^>\s]+>|https?:\/\/[^\s)>\]]*[^\s)>\].,;:!?]/g, 'link')
      .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
      .replace(/`([^`]*)`/g, '$1'),
  )
    .replace(/\*+|~~/g, '')
    .replace(/(^|[^\w])_{1,2}([^_\n]+?)_{1,2}(?=[^\w]|$)/g, '$1$2')
    .replace(/\s*(?:->|=>|→|⇒)\s*/g, ' to ')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')

/** Cuts at the last sentence that fits, and says that more is on screen. */
const hold = (text: string, limit: number): string => {
  if (limit <= 0 || text.length <= limit) {
    return text
  }

  const head = text.slice(0, limit)
  const end = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('? '),
    head.lastIndexOf('! '),
    head.lastIndexOf('\n'),
  )
  const kept = end > limit / 2 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(' '))

  return `${kept.trim()}\nThe rest is on screen.`
}

/**
 * What to say for `markdown`; `""` when nothing of it is prose. `limit` holds
 * the spoken text to that many characters (0: no limit).
 */
export const toSpeech = (markdown: string, limit = 0): string => {
  const lines: string[] = []
  let isInFence = false
  let isInTable = false

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (!isInFence) {
        lines.push('Code block.')
      }
      isInFence = !isInFence
      continue
    }
    if (isInFence) {
      continue
    }

    const isTableRow = /^\s*\|.*\|\s*$/.test(line)
    if (isTableRow) {
      if (!isInTable) {
        lines.push('Table.')
      }
      isInTable = true
      continue
    }
    isInTable = false

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      continue
    }

    const prose = sayInline(unmarked(line)).replace(/[ \t]+/g, ' ').trim()
    const said = isOwnSentence(line) ? closed(prose) : prose
    if (said !== '' && /[\p{L}\p{N}]/u.test(said)) {
      lines.push(said)
    }
  }

  return hold(lines.join('\n'), limit)
}
