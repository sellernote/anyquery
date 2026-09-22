# AnyQuery

A VS Code extension for querying MySQL, PostgreSQL, MongoDB, Redis and OpenSearch in one tab.

Built with React and TypeScript. Needs VS Code 1.101 or later.

## Why AnyQuery?

- **Five databases in one tab.** Check your OpenSearch indices right next to your MySQL, PostgreSQL, MongoDB and Redis data, without switching tools.
- **Each database's own query syntax.** Paste queries from mongosh, redis-cli or Kibana Dev Tools and run them as is. No new query language to learn.
- **Large results don't load all at once.** MySQL, PostgreSQL and MongoDB results are read from the server one page at a time.
- **No limits.** Save as many connections and open as many query tabs as you need.
- **Free and open source.** MIT licensed, with no paid tier.

## Features

- Browse databases, schemas, tables, collections, keys and indices in a tree
- Syntax highlighting, plus table name autocomplete for MySQL
- View results as a table or as JSON, 200 rows per page
- Download every row of a result as CSV or JSON
- Passwords are encrypted with the OS keychain

## Getting started

You need Node.js 20.19+ or 22.12+, and pnpm.

```bash
git clone https://github.com/sellernote/anyquery.git
cd anyquery
pnpm install
pnpm install:package  # builds, packages and installs it into VS Code
```

Then run `Developer: Reload Window` in VS Code to load the new version. Run the same command again after you change the code. It needs the `code` command in your PATH (in VS Code, run `Shell Command: Install 'code' command in PATH`).

To make a `.vsix` file to share, run `pnpm package`. It writes `anyquery-<version>.vsix`.

npm works too.

### Development

Open the folder in VS Code and press `F5`. It builds the extension and opens a new VS Code window with it loaded. Run `pnpm watch` to rebuild on every change, then run `Developer: Reload Webviews` or reload the window.

## Usage

1. Click the AnyQuery icon in the Activity Bar, or run `AnyQuery: Open` from the Command Palette (`Cmd+Shift+P`, or `Ctrl+Shift+P` on Windows and Linux).
2. Click `+` at the top left to add a connection. Click `Test connection` to check it first.
3. Expand a connection to see its databases and tables (or collections, keys, indices). Click a table to query it in a new tab.
4. Press `Cmd+Enter` (`Ctrl+Enter` on Windows and Linux) to run. If text is selected, only the selection runs.
5. Results show 200 rows per page. Use `Previous` and `Next` above the results to change pages.
6. Double-click a cell to see its full value. Click a column header to sort. Sorting and copying apply to the current page only.
7. Click `Download` to save every row as CSV or JSON. Pages not read yet are read from the database straight into the file. After that, the tab cannot page further until you run the query again.

### Query syntax

| Database | Syntax | Example |
|---|---|---|
| MySQL | SQL. Statements separated by `;` run in order and stop at the first error. Each tab has its own connection, so variables and transactions persist. | `SELECT * FROM users LIMIT 10;` |
| PostgreSQL | SQL. Statements separated by `;` run in order and stop at the first error. `;` inside `$$ ... $$` function bodies does not split. Each tab has its own connection. | `SELECT * FROM users LIMIT 10;` |
| MongoDB | mongosh-style JavaScript | `db.users.find({ age: { $gt: 20 } }).sort({ _id: -1 }).limit(20)` |
| Redis | One command per line, like redis-cli | `HGETALL user:1` |
| OpenSearch | Kibana Dev Tools syntax: a request line followed by a JSON body | `GET /books/_search` + body |

MongoDB also supports `show dbs`, `show collections`, `ObjectId()`, `ISODate()`, `NumberLong()` and `NumberDecimal()`.

### Paging

The next page is read from the database when you click `Next`. After you rerun the query in the same tab or close the tab, the old result can no longer be paged. Closing the AnyQuery panel closes every connection.

| Database | How the next page is read |
|---|---|
| MySQL | The result is streamed and paused between pages. See the notes below. |
| PostgreSQL | A server-side cursor reads one page at a time. See the notes below. |
| MongoDB | The cursor stays open. The server closes cursors that are idle for 10 minutes. |
| OpenSearch | For `_search`, the same request is sent again with a larger `from`. The page size is the request's `size` (default 10). The request fails once `from + size` goes over `index.max_result_window` (default 10,000). Page `scroll` and `search_after` requests yourself. |
| Redis and others | The full reply is kept in the extension and sent one page at a time. |

MySQL notes:

- Up to 5,000 rows are read ahead. Smaller results finish right away.
- Larger queries are paused. While paused, the tab's connection cannot run other queries and holds a table metadata lock. The result is closed if no page is read for 5 minutes.
- Each tab's connection sets `net_write_timeout` to 600 seconds, so the server does not drop it during a pause.
- Rerunning stops the previous query with `KILL QUERY`. The connection stays open, so variables and transactions persist.
- If you run several statements, only the last one can be paged. The others show their first page only.

PostgreSQL notes:

- A connection opens only one database. Picking another database in a tab opens a new connection, so variables and transactions from before are lost. Without a default database, `postgres` is used.
- While a result has more pages, its cursor stays open. The tab's connection cannot run other queries, and the cursor's transaction keeps its locks, so for example `ALTER TABLE` on that table waits. The result is closed if no page is read for 5 minutes.
- Dates and times are shown as the text the server sends, not converted to your time zone.
- If you run several statements, only the last one can be paged. The others show their first page only.

### Where data is stored

Connections are saved in VS Code's extension storage (`globalState`). Passwords are saved separately in VS Code's `SecretStorage`, which uses the OS keychain.

## Limitations

Not supported yet:

- SSH tunnels
- Canceling a running query
- AWS SigV4 auth for OpenSearch (basic auth works)
- Redis Cluster and Sentinel
- Saving tabs and editor content (they are lost when the panel closes)

## Contributing

Issues and pull requests are welcome. Run `pnpm typecheck` before you open a pull request.

### Project structure

```
src/
  shared/           Code shared by the extension and the UI
    rpc.ts          Message format between the webview and the extension
  extension/        Runs in the VS Code extension host
    index.ts        Opens the panel and answers webview requests
    store.ts        Saved connections (passwords in SecretStorage)
    cursors.ts      Cursors for reading more pages
    drivers/        One driver per database
  webview/          React UI shown in the panel
    api.ts          Calls the extension
scripts/build.mjs   Bundles both parts with esbuild
```

All database access happens in the extension. The UI runs in a webview and talks to it only through messages (`webview/api.ts`). Each method of the `Api` interface in `shared/types.ts` is handled by the function of the same name in `extension/index.ts`.

### Adding a database

1. Implement the `Driver` interface (`drivers/types.ts`) in `src/extension/drivers/`. If a result has more than one page, return only the first page with a `cursor`. For results already in memory, use `paginate()` (`drivers/util.ts`).
2. Register it in `createDriver` in `drivers/index.ts`.
3. Add it to `DbType`, `DEFAULT_PORTS` and `DB_LABELS` in `shared/types.ts`.
4. Add syntax highlighting in `languageFor` in `webview/components/Editor.tsx`.

## License

[MIT](LICENSE)
