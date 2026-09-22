import type { Api } from './types'

/** A call from the webview to the extension */
export interface Request {
  id: number
  method: keyof Api
  /** Encoded arguments */
  args: string
}

/** The extension's answer. body is an encoded Reply. */
export interface Response {
  id: number
  body: string
}

export type Reply = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Webview messages are sent as JSON, which turns undefined in arrays into null.
 * An empty cell (undefined) and NULL look different in the grid, so undefined is kept with a marker.
 */
const UNDEFINED = '\u0000undefined'

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v === undefined ? UNDEFINED : v))
}

export function decode(text: string): unknown {
  return restore(JSON.parse(text))
}

function restore(value: unknown): unknown {
  if (value === UNDEFINED) return undefined
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = restore(value[i])
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) obj[key] = restore(obj[key])
  }
  return value
}
