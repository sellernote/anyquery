import * as vscode from 'vscode'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { DownloadFormat, DownloadRequest, DownloadResult, ResultPage } from '@shared/types'
import { plural } from '@shared/format'

/** The rest of a result that has more pages */
export interface Rest {
  next(): Promise<ResultPage>
  close(): Promise<void>
}

type Page = DownloadRequest['pages'][number]

interface ResultFile {
  /** Rows (or JSON items) written so far */
  count: number
  add(page: Page, columns: string[]): Promise<void>
  finish(columns: string[]): Promise<void>
  /** Removes what was written */
  abort(): Promise<void>
}

/** Starts at Downloads, then remembers the folder picked last */
let lastFolder = join(homedir(), 'Downloads')

/**
 * Saves a result to a file the user picks. Pages not read yet are read from the cursor straight into the file,
 * so large results are not held in memory. Returns null if the user cancels the save dialog.
 */
export async function download(req: DownloadRequest, rest?: Rest): Promise<DownloadResult | null> {
  const formats: DownloadFormat[] = !req.columns ? ['json'] : req.format === 'csv' ? ['csv', 'json'] : ['json', 'csv']
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(lastFolder, `${fileName(req.name)}.${formats[0]}`)),
    filters: Object.fromEntries(formats.map((f) => [f.toUpperCase(), [f]])),
    saveLabel: 'Download'
  })
  if (!uri) return null
  const path = uri.fsPath
  lastFolder = dirname(path)
  const ext = extname(path).slice(1).toLowerCase()
  const format = formats.includes(ext as DownloadFormat) ? (ext as DownloadFormat) : formats[0]

  let columns = req.columns ?? []
  let done = false
  const file = format === 'csv' ? await CsvFile.create(path) : await JsonFile.create(path, jsonMode(req, !!rest))
  try {
    for (const page of req.pages) await file.add(page, columns)
    if (rest) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${basename(path)}`, cancellable: true },
        async (progress, token) => {
          let page: ResultPage
          do {
            if (token.isCancellationRequested) throw new Error('Download canceled. The file was not saved.')
            page = await rest.next()
            if (page.columns) columns = page.columns
            await file.add(page, columns)
            progress.report({ message: plural(file.count, 'row') })
          } while (page.hasMore)
        }
      )
    }
    await file.finish(columns)
    done = true
  } finally {
    if (!done) {
      await file.abort()
      await rest?.close()
    }
  }

  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder'
  vscode.window
    .showInformationMessage(`Saved ${plural(file.count, 'row')} to ${basename(path)}`, 'Open', reveal)
    .then((choice) => {
      if (choice === 'Open') vscode.commands.executeCommand('vscode.open', uri)
      else if (choice === reveal) vscode.commands.executeCommand('revealFileInOS', uri)
    })
  return { file: path, rows: file.count }
}

function fileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 100) || 'result'
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Rows go to a side file first, because columns can grow page by page (MongoDB, OpenSearch)
 * and the header is known only at the end.
 */
class CsvFile implements ResultFile {
  count = 0
  private writing = false

  private constructor(
    private path: string,
    private part: string,
    private body: FileHandle
  ) {}

  static async create(path: string): Promise<CsvFile> {
    const part = `${path}.part`
    return new CsvFile(path, part, await open(part, 'w'))
  }

  async add(page: Page, columns: string[]): Promise<void> {
    if (page.rows.length === 0) return
    await this.body.write(page.rows.map((row) => columns.map((_, i) => csvCell(row[i])).join(',') + '\r\n').join(''))
    this.count += page.rows.length
  }

  async finish(columns: string[]): Promise<void> {
    await this.body.close()
    this.writing = true
    const part = this.part
    // The BOM lets Excel read the file as UTF-8
    const header = '﻿' + columns.map(csvCell).join(',') + '\r\n'
    await pipeline(
      async function* () {
        yield header
        yield* createReadStream(part)
      },
      createWriteStream(this.path)
    )
    await rm(part)
  }

  async abort(): Promise<void> {
    await this.body.close().catch(() => {})
    await rm(this.part, { force: true })
    // An existing file is left alone unless it was already being overwritten
    if (this.writing) await rm(this.path, { force: true })
  }
}

/**
 * items: the JSON of each page is an array (MongoDB documents, Redis replies). The arrays are joined.
 * rows: table rows become objects keyed by column (MySQL, PostgreSQL, OpenSearch searches with several pages).
 * value: a single JSON value is written as is.
 */
type JsonMode = 'items' | 'rows' | 'value'

function jsonMode(req: DownloadRequest, more: boolean): JsonMode {
  const json = req.pages[0]?.json
  if (Array.isArray(json)) return 'items'
  if (req.columns && (json === undefined || more || req.pages.length > 1)) return 'rows'
  return 'value'
}

class JsonFile implements ResultFile {
  count = 0
  private first = true

  private constructor(
    private path: string,
    private mode: JsonMode,
    private handle: FileHandle
  ) {}

  static async create(path: string, mode: JsonMode): Promise<JsonFile> {
    return new JsonFile(path, mode, await open(path, 'w'))
  }

  async add(page: Page, columns: string[]): Promise<void> {
    if (this.mode === 'value') {
      await this.handle.write((JSON.stringify(page.json, null, 2) ?? 'null') + '\n')
      this.count = page.rows.length
      return
    }
    const items =
      this.mode === 'items'
        ? Array.isArray(page.json)
          ? page.json
          : []
        : page.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
    let text = ''
    for (const item of items) {
      text += (this.first ? '[\n  ' : ',\n  ') + (JSON.stringify(item, null, 2) ?? 'null').replace(/\n/g, '\n  ')
      this.first = false
    }
    if (text) await this.handle.write(text)
    this.count += items.length
  }

  async finish(): Promise<void> {
    if (this.mode !== 'value') await this.handle.write(this.first ? '[]\n' : '\n]\n')
    await this.handle.close()
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => {})
    await rm(this.path, { force: true })
  }
}
