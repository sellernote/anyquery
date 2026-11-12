# How AnyQuery works

How queries, paging, cell editing and canceling work in each database. For the basics, see the [README](../README.md).

## Running queries

- **MySQL and PostgreSQL**: each tab has its own connection, so variables and transactions carry over between runs in the tab.
- **MySQL**: to create a procedure or trigger, change the delimiter with `DELIMITER //` and back with `DELIMITER ;`, like the mysql client.
- **PostgreSQL**: a connection opens only one database. Picking another database in a tab opens a new connection, so variables and transactions from before are lost. Without a default database, `postgres` is used. Dates and times are shown as the text the server sends, not converted to your time zone.
- **MongoDB**: besides mongosh-style code, `show dbs`, `show collections`, `ObjectId()`, `ISODate()`, `NumberLong()` and `NumberDecimal()` work.

## Paging

The next page is read from the database when you click `Next`. Sorting and copying apply to the current page only.

| Database | How the next page is read |
|---|---|
| MySQL | Up to 5,000 rows are read ahead. A larger result is streamed and paused between pages. |
| PostgreSQL | Up to 5,000 rows are read ahead. A larger result is read with a server-side cursor. |
| MongoDB | The cursor stays open. The server closes cursors that are idle for 10 minutes. |
| OpenSearch | For `_search`, the same request is sent again with a larger `from`. The page size is the request's `size` (default 10). The request fails once `from + size` goes over `index.max_result_window` (default 10,000). Page `scroll` and `search_after` requests yourself. |
| Redis and others | The full reply is kept in the extension and sent one page at a time. |

While a MySQL or PostgreSQL result has rows left to read:

- The tab's connection cannot run other queries.
- The table stays locked. MySQL holds a metadata lock, and PostgreSQL keeps the cursor's transaction and its locks. For example, `ALTER TABLE` on that table waits.
- The result closes if no page is read for 5 minutes. In MySQL, the tab's connection sets `net_write_timeout` to 600 seconds, so the server does not drop it while paused.

Also:

- If you run several statements, only the last one can be paged. The others show their first page only.
- Running the query again or closing the tab closes the old result. In MySQL, the old query is stopped with `KILL QUERY`, and the connection stays open.
- `Download` reads the pages not read yet straight into the file. After that, the tab cannot page further until you run the query again.

## Editing results

A result can be edited when AnyQuery can tell which row each cell belongs to. It then shows `Editable: <table>` above the result.

1. Double-click a cell, change the value and click `Apply` (`Cmd+Enter`). `Set NULL` sets NULL. Changed cells are highlighted.
2. Click `Save` to save every change, or `Discard` to drop them. Running the query again or closing the tab asks first.

Type values as they are shown. For JSON and arrays, type JSON.

| Database | Editable when | How changes are saved |
|---|---|---|
| MySQL, PostgreSQL | The columns come from one table, and its primary key is in the result. A join works if you select columns from only one table. | One `UPDATE ... WHERE <primary key>` per row, in one transaction. If one fails, nothing is saved. |
| OpenSearch | `_search` results whose hits have `_source` | One update per document by `_index` and `_id`, with `refresh=wait_for`. There are no transactions, so some documents can fail while others are saved. Failed ones stay unsaved. |

These cannot be edited:

- Primary key columns, `_index` and `_id`
- Expressions, generated columns, binary columns (shown as hex), and PostgreSQL `point` and `circle`
- Results from views, tables without a primary key, `UNION` and self joins
- PostgreSQL results where the table name appears more than once in the query, or the query uses `WITH`. PostgreSQL does not say which alias a column came from, so these could be self joins.
- OpenSearch documents with custom routing, and fields from `fields` or `docvalue_fields`

In MySQL and PostgreSQL:

- Changes are saved on the tab's connection, like an `UPDATE` you run in the tab.
- If the tab has an open transaction (after `BEGIN`, or with `autocommit` off in MySQL), the changes join it and are not committed. Run `COMMIT` or `ROLLBACK` yourself.
- If the result still has rows to read, saving closes it, so it cannot page further.
- Each row must still exist with the same primary key. Otherwise nothing is saved.

After saving, only the edited cells change. Run the query again to see other values the database changed, such as `ON UPDATE` timestamps. OpenSearch search results always show `_index`, since it is needed to find each document.

## Canceling

`Cancel` stops the statement that is running and skips the ones after it. A statement that already finished keeps its result, even if it finished as you clicked.

| Database | What Cancel does |
|---|---|
| MySQL | Stops the statement on the server. The tab's connection stays open, so variables and transactions persist. `SLEEP()` returns 1 instead of failing. |
| PostgreSQL | Stops the statement on the server. The tab's connection stays open, but an open transaction is aborted. Run `ROLLBACK` to continue. |
| OpenSearch | Closes the request. OpenSearch stops a search when its request is closed. |
| Redis | Stops waiting and reconnects, so a blocking command such as `BLPOP` lets go. The server still finishes a slow command such as `KEYS`. |
| MongoDB | Stops waiting. The server still finishes the operation. |

## Where data is stored

- Connections are saved in VS Code's extension storage (`globalState`).
- Passwords and MongoDB URIs are saved in VS Code's `SecretStorage`, which uses the OS keychain.
- Open tabs and their queries are saved per workspace (`workspaceState`). Results are not kept.
