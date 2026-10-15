/** Newline-delimited JSON framing shared by the link server and its tests. */
export const MAX_LINE = 256 * 1024

export interface LinkMessage {
  type: string
  [key: string]: unknown
}

export class LineSplitter {
  private buffer = ''
  private onMessage: (m: LinkMessage) => void
  private onError: (err: Error) => void

  constructor(onMessage: (m: LinkMessage) => void, onError: (err: Error) => void) {
    this.onMessage = onMessage
    this.onError = onError
  }

  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) {
      this.onError(new Error('line exceeds MAX_LINE'))
      this.buffer = ''
      return
    }
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      if (line.length > MAX_LINE) {
        this.onError(new Error('line exceeds MAX_LINE'))
        return
      }
      try {
        const parsed = JSON.parse(line) as unknown
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as LinkMessage).type === 'string'
        )
          this.onMessage(parsed as LinkMessage)
        else this.onError(new Error('message without a type'))
      } catch (err) {
        this.onError(err as Error)
      }
    }
  }
}

export function encode(m: LinkMessage): string {
  return `${JSON.stringify(m)}\n`
}
