/**
 * Reads the text typed into a cell as a value of the same kind as the old one.
 * If the old value was text, the new value is text. Otherwise it is read as JSON, e.g. 42, true or {"a": 1}.
 * With no old value, text that is not JSON stays text. Throws if the text must be JSON but is not.
 */
export function parseEdit(text: string, old: unknown): unknown {
  if (typeof old === 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    if (old === null || old === undefined) return text
    throw new Error(`Not valid JSON: ${text.length > 40 ? text.slice(0, 40) + '...' : text}`)
  }
}
