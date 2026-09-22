/** plural(1, 'row') → "1 row", plural(1200, 'row') → "1,200 rows" */
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}
