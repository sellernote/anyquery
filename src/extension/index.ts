import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import type { Api } from '@shared/types'
import { decode, encode, type Reply, type Request, type Response } from '@shared/rpc'
import { ConnectionStore } from './store'
import { CursorRegistry } from './cursors'
import { DriverManager, testConnection } from './drivers'
import { download } from './download'
import { errorMessage } from './drivers/util'

let store: ConnectionStore
let drivers: DriverManager
const cursors = new CursorRegistry()
let panel: vscode.WebviewPanel | undefined

/** An open MySQL cursor ties up its connection. Close cursors first, then disconnect. */
async function closeDriver(id: string): Promise<void> {
  await cursors.closeConnection(id)
  await drivers.close(id)
}

async function closeAll(): Promise<void> {
  await cursors.closeAll()
  await drivers.closeAll()
}

/** What the webview can call. The webview side is in webview/api.ts. */
const api: Api = {
  listConnections: async () => store.list(),
  saveConnection: async (config) => {
    // Settings changed, so close the existing connection
    await closeDriver(config.id)
    return store.save(config)
  },
  removeConnection: async (id) => {
    await closeDriver(id)
    await store.remove(id)
  },
  testConnection: (config) => testConnection(config),
  connect: async (id) => {
    await drivers.get(id)
  },
  disconnect: (id) => closeDriver(id),
  children: async (id, path) => (await drivers.get(id)).children(path),
  databases: async (id) => (await drivers.get(id)).databases(),
  openQuery: async (id, path) => (await drivers.get(id)).openQuery(path),
  execute: async (id, query, ctx) => {
    // A tab keeps only its latest result, so close cursors from the previous run
    await cursors.closeSession(id, ctx.sessionId)
    const results = await (await drivers.get(id)).execute(query, ctx)
    return results.map(({ cursor, ...result }) =>
      cursor ? { ...result, cursorId: cursors.add(id, ctx.sessionId, cursor) } : result
    )
  },
  fetchPage: (id, cursorId) => cursors.next(id, cursorId),
  saveEdits: async (id, sessionId, req) => {
    const driver = await drivers.get(id)
    if (!driver.saveEdits) throw new Error('This database does not support editing')
    // Edits are saved on the tab's connection, which an unfinished result ties up
    const closedCursors = await cursors.releaseSession(id, sessionId)
    try {
      return { ...(await driver.saveEdits(sessionId, req)), closedCursors }
    } catch (err) {
      return { saved: [], error: errorMessage(err), closedCursors }
    }
  },
  closeSession: async (id, sessionId) => {
    await cursors.closeSession(id, sessionId)
    const driver = await drivers.get(id).catch(() => null)
    await driver?.closeSession(sessionId)
  },
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  copyText: async (text) => {
    await vscode.env.clipboard.writeText(text)
  },
  download: (req) => {
    const { connectionId: id, cursorId } = req
    const rest = cursorId && { next: () => cursors.next(id, cursorId), close: () => cursors.remove(id, cursorId) }
    return download(req, rest || undefined)
  }
}

async function handle(request: Request): Promise<Reply> {
  try {
    if (!Object.hasOwn(api, request.method)) throw new Error(`Unknown method: ${request.method}`)
    const fn = api[request.method] as (...args: unknown[]) => Promise<unknown>
    return { ok: true, value: await fn(...(decode(request.args) as unknown[])) }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

function openPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal()
    return
  }
  const root = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')
  const current = vscode.window.createWebviewPanel('anyquery', 'AnyQuery', vscode.ViewColumn.Active, {
    enableScripts: true,
    // Keep tabs and results when the panel is in the background
    retainContextWhenHidden: true,
    localResourceRoots: [root]
  })
  panel = current
  current.webview.html = html(current.webview, root)

  let disposed = false
  current.webview.onDidReceiveMessage(async (request: Request) => {
    const reply = await handle(request)
    if (disposed) return
    const response: Response = { id: request.id, body: encode(reply) }
    current.webview.postMessage(response)
  })

  // Closing the panel closes its tabs, so close every connection too
  current.onDidDispose(() => {
    disposed = true
    panel = undefined
    closeAll().catch(() => {})
  })
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString()
  const nonce = randomBytes(16).toString('base64')
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`
  ].join('; ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${asset('index.css')}" />
    <title>AnyQuery</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${asset('index.js')}"></script>
  </body>
</html>`
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = await ConnectionStore.load(context)
  drivers = new DriverManager((id) => store.get(id))
  context.subscriptions.push(vscode.commands.registerCommand('anyquery.open', () => openPanel(context)))

  // The activity bar icon opens the panel. VS Code needs a view behind the icon, but it only shows
  // the welcome button from package.json, so the side bar is closed right away.
  const view = vscode.window.createTreeView<vscode.TreeItem>('anyquery.home', {
    treeDataProvider: { getTreeItem: (item) => item, getChildren: () => [] }
  })
  // Clicking the icon may be what activated the extension, so the view can already be visible
  if (view.visible) openFromActivityBar(context)
  context.subscriptions.push(
    view,
    view.onDidChangeVisibility((e) => {
      if (e.visible) openFromActivityBar(context)
    })
  )
}

async function openFromActivityBar(context: vscode.ExtensionContext): Promise<void> {
  openPanel(context)
  // Switch to Explorer first. Otherwise toggling the side bar (Cmd+B) would show this view and close it again.
  await vscode.commands.executeCommand('workbench.view.explorer')
  await vscode.commands.executeCommand('workbench.action.closeSidebar')
}

export function deactivate(): Promise<void> {
  return closeAll()
}
