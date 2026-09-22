import type { NodeKind } from '@shared/types'

const PATHS: Record<string, string> = {
  database: 'M8 2c3.3 0 6 1.1 6 2.5v7c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5v-7C2 3.1 4.7 2 8 2Zm0 1.2c-2.8 0-4.8.9-4.8 1.3S5.2 5.8 8 5.8s4.8-.9 4.8-1.3S10.8 3.2 8 3.2ZM3.2 6.4V8c0 .4 2 1.3 4.8 1.3s4.8-.9 4.8-1.3V6.4C11.7 7 10 7.3 8 7.3S4.3 7 3.2 6.4Zm0 3.5v1.6c0 .4 2 1.3 4.8 1.3s4.8-.9 4.8-1.3V9.9c-1.1.6-2.8.9-4.8.9s-3.7-.3-4.8-.9Z',
  table: 'M2 3h12v10H2V3Zm1.2 1.2v2h9.6v-2H3.2Zm0 3.2v4.4h4.2V7.4H3.2Zm5.4 0v4.4h4.2V7.4H8.6Z',
  view: 'M8 4c3.1 0 5.4 2.2 6.3 4-.9 1.8-3.2 4-6.3 4S2.6 9.8 1.7 8C2.6 6.2 4.9 4 8 4Zm0 1.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 1.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z',
  column: 'M4 3h8v1.4H4V3Zm0 4.3h8v1.4H4V7.3Zm0 4.3h8V13H4v-1.4Z',
  collection: 'M2 4h4.5l1.2 1.3H14V13H2V4Zm1.2 2.5v5.3h9.6V6.5H3.2Z',
  index: 'M3 3h10v1.4H3V3Zm0 3h10v1.4H3V6Zm0 3h10v1.4H3V9Zm0 3h6v1.4H3V12Z',
  key: 'M10.5 2a3.5 3.5 0 1 1-1.3 6.8L8 10H6.5v1.5H5V13H2v-2.5l4.2-4.2A3.5 3.5 0 0 1 10.5 2Zm.8 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  chevron: 'M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5l1-1Z',
  refresh: 'M8 2.5a5.5 5.5 0 0 1 5.2 3.7H14V2.9l-1.4 1.4A5.5 5.5 0 1 0 13.4 9h-1.3A4.2 4.2 0 1 1 8 3.8V2.5Z',
  edit: 'M11.3 2.3 13.7 4.7 5.4 13H3v-2.4l8.3-8.3Zm0 1.9-6.9 6.9v.5h.5l6.9-6.9-.5-.5Z',
  trash: 'M6 2h4l.5 1H13v1.3H3V3h2.5L6 2ZM4 5.3h8L11.4 14H4.6L4 5.3Zm1.4 1.2.4 6.2h4.4l.4-6.2H5.4Z',
  plus: 'M7.3 3h1.4v4.3H13v1.4H8.7V13H7.3V8.7H3V7.3h4.3V3Z',
  play: 'M5 3.2 12.5 8 5 12.8V3.2Z',
  unplug: 'M3 3.9 3.9 3 13 12.1l-.9.9-2.3-2.3-.8.8A3 3 0 0 1 5 11.6L3.4 13.2l-.6-.6L4.4 11A3 3 0 0 1 4.5 7l.8-.8L3 3.9Zm8.6-.8.6.6-1.6 1.6a3 3 0 0 1-.1 4l-.6.6-4.2-4.2.6-.6a3 3 0 0 1 4-.1l1.3-1.9Z',
  close: 'M4.2 3.3 8 7.1l3.8-3.8.9.9L8.9 8l3.8 3.8-.9.9L8 8.9l-3.8 3.8-.9-.9L7.1 8 3.3 4.2l.9-.9Z',
  query: 'M3 2h7l3 3v9H3V2Zm1.2 1.2v9.6h7.6V5.6H9.6V3.2H4.2Zm1.3 4h5v1.1h-5V7.2Zm0 2.3h5v1.1h-5V9.5Z'
}

export function Icon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.column} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

export function kindIcon(kind: NodeKind): string {
  if (kind === 'more') return 'column'
  // A schema is a folder of tables
  if (kind === 'schema') return 'collection'
  return kind
}
