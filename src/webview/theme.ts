import { useSyncExternalStore } from 'react'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

/** VS Code marks the theme kind with a class on body, and changes it when the user switches themes */
const isDark = () => !/\bvscode-(light|high-contrast-light)\b/.test(document.body.className)

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

/** True while VS Code uses a dark theme */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribe, isDark)
}

/** Editor colors come from the VS Code theme. Syntax colors cannot, so they depend only on dark or light. */
function editorTheme(dark: boolean): Extension {
  const colors = EditorView.theme(
    {
      '&': {
        color: 'var(--vscode-editor-foreground, var(--text))',
        backgroundColor: 'var(--vscode-editor-background, var(--bg))'
      },
      '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground, var(--text))' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, var(--text))' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--vscode-editor-selectionBackground, #3e4451)' },
      '.cm-activeLine': {
        backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)',
        boxShadow: 'inset 0 0 0 1px var(--vscode-editor-lineHighlightBorder, transparent)'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background, var(--bg)))',
        color: 'var(--vscode-editorLineNumber-foreground, var(--muted))',
        border: 'none'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--vscode-editorLineNumber-activeForeground, var(--text))'
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--vscode-editorBracketMatch-background, transparent)',
        outline: '1px solid var(--vscode-editorBracketMatch-border, var(--muted))'
      },
      '.cm-searchMatch': { backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground, #72a1ff59)' },
      '.cm-panels': {
        backgroundColor: 'var(--vscode-editorWidget-background, var(--bg-panel))',
        color: 'var(--vscode-editorWidget-foreground, var(--text))'
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--vscode-editorSuggestWidget-background, var(--bg-panel))',
        color: 'var(--vscode-editorSuggestWidget-foreground, var(--text))',
        border: '1px solid var(--vscode-editorSuggestWidget-border, var(--border))'
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--bg-active))',
        color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)'
      },
      '.cm-completionMatchedText': {
        textDecoration: 'none',
        color: 'var(--vscode-editorSuggestWidget-highlightForeground, var(--focus))'
      },
      '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted)' }
    },
    { dark }
  )
  return [colors, syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)]
}

export const editorThemes = { dark: editorTheme(true), light: editorTheme(false) }
