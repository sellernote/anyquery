import { useMemo, useRef } from 'react'
import CodeMirror, { EditorView, keymap, Prec, type Extension } from '@uiw/react-codemirror'
import { StreamLanguage } from '@codemirror/language'
import { MySQL, PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import type { DbType } from '@shared/types'

/** One redis-cli line: the first word is the command, the rest are arguments */
const redisLanguage = StreamLanguage.define<null>({
  token(stream) {
    if (stream.sol()) {
      stream.eatSpace()
      if (stream.match(/^(#|\/\/).*/)) return 'comment'
      if (stream.match(/^\S+/)) return 'keyword'
      return null
    }
    if (stream.eatSpace()) return null
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return 'string'
    if (stream.match(/^-?\d+(\.\d+)?(?=\s|$)/)) return 'number'
    stream.match(/^\S+/)
    return null
  }
})

/** Kibana Dev Tools syntax: a request line followed by a JSON body */
const openSearchLanguage = StreamLanguage.define<null>({
  token(stream) {
    if (stream.sol() && stream.match(/^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)(?=\s)/i)) return 'keyword'
    if (stream.eatSpace()) return null
    if (stream.match(/^(#|\/\/).*/)) return 'comment'
    if (stream.match(/^"(?:[^"\\]|\\.)*"\s*(?=:)/)) return 'propertyName'
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^(true|false|null)\b/)) return 'atom'
    if (stream.match(/^\/\S*/)) return 'typeName'
    stream.next()
    return null
  }
})

export function languageFor(type: DbType, schema?: SQLNamespace): Extension {
  switch (type) {
    case 'mysql':
      return sql({ dialect: MySQL, schema, upperCaseKeywords: true })
    case 'postgres':
      return sql({ dialect: PostgreSQL, upperCaseKeywords: true })
    case 'mongodb':
      return javascript()
    case 'redis':
      return redisLanguage
    case 'opensearch':
      return openSearchLanguage
  }
}

/** Returns the selected text, or undefined if nothing is selected */
export function selectedText(view: EditorView | undefined): string | undefined {
  if (!view) return undefined
  const text = view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join('\n')
  return text.trim() ? text : undefined
}

interface Props {
  type: DbType
  value: string
  schema?: SQLNamespace
  onChange(value: string): void
  onRun(text?: string): void
  onView?(view: EditorView): void
}

export function Editor({ type, value, schema, onChange, onRun, onView }: Props) {
  const runRef = useRef(onRun)
  runRef.current = onRun

  const extensions = useMemo(
    () => [
      languageFor(type, schema),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              runRef.current(selectedText(view))
              return true
            }
          }
        ])
      )
    ],
    [type, schema]
  )

  return (
    <CodeMirror
      className="editor"
      value={value}
      height="100%"
      theme={oneDark}
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => onView?.(view)}
      basicSetup={{ foldGutter: false, highlightActiveLine: true }}
    />
  )
}

export function JsonViewer({ value }: { value: string }) {
  const extensions = useMemo(() => [json(), EditorView.lineWrapping], [])
  return (
    <CodeMirror
      className="json-viewer"
      value={value}
      height="100%"
      theme={oneDark}
      editable={false}
      extensions={extensions}
      basicSetup={{ foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false }}
    />
  )
}
