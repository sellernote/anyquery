import { parseEdit } from '@shared/edit'

/** Key of an edited cell in ResultState.edits */
export function cellKey(page: number, row: number, column: number): string {
  return `${page}:${row}:${column}`
}

/** The text a cell starts with when edited */
export function editText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

/** How an edited value is shown. It keeps the kind of the old value where it can, so a number stays a number. */
export function editedValue(value: string | null, old: unknown): unknown {
  if (value === null) return null
  try {
    return parseEdit(value, old)
  } catch {
    return value
  }
}
