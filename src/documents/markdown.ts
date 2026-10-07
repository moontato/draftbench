import { Lexer, type Token, type Tokens } from 'marked'
export interface MarkdownFile {
  body: string
  frontmatter: string
  newline: '\n' | '\r\n'
  unsupported: string[]
  bom?: boolean
}
export function readMarkdown(source: string): MarkdownFile {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const bom = source.startsWith('\uFEFF')
  const normalized = source.slice(bom ? 1 : 0).replace(/\r\n/g, '\n')
  const frontmatter = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0] ?? ''
  const body = normalized.slice(frontmatter.length)
  const unsupported = new Set<string>()
  const visit = (token: Token) => {
    if (['html', 'table', 'image'].includes(token.type)) unsupported.add(token.type)
    if (
      (token.type === 'def' && (token as Tokens.Def).tag.startsWith('^')) ||
      (token.type === 'text' && /(?<!\\)\[\^[^\]]+\]/.test(token.raw))
    )
      unsupported.add('footnotes')
    if (token.type === 'list' && (token as Tokens.List).items.some((item) => item.task))
      unsupported.add('task list')
    if ('tokens' in token && Array.isArray(token.tokens)) token.tokens.forEach(visit)
    if (token.type === 'list')
      (token as Tokens.List).items.forEach((item) => item.tokens.forEach(visit))
  }
  Lexer.lex(body).forEach(visit)
  return { body, frontmatter, newline, unsupported: [...unsupported], bom }
}
export function writeMarkdown(file: MarkdownFile, body: string): string {
  return (
    (file.bom ? '\uFEFF' : '') +
    file.frontmatter +
    body.replace(/\r\n/g, '\n').trimEnd() +
    '\n'
  ).replace(/\n/g, file.newline)
}
