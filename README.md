# AnyQuery

Query MySQL, PostgreSQL, MongoDB, Redis and OpenSearch in one VS Code tab.

## Why AnyQuery?

- **Five databases in one tab.** Check your OpenSearch indices right next to your MySQL, PostgreSQL, MongoDB and Redis data, without switching tools.
- **Each database's own query syntax.** Paste queries from mongosh, redis-cli or Kibana Dev Tools and run them as is. No new query language to learn.
- **Large results load page by page.** MySQL, PostgreSQL and MongoDB results are read from the server one page at a time.
- **No limits.** Save as many connections and open as many query tabs as you need.
- **Free and open source.** MIT licensed, with no paid tier.

## Features

- Browse databases, tables, collections, keys and indices in a tree, and filter it by name
- Autocomplete table and column names in MySQL and PostgreSQL
- View results as a table or as JSON, 200 rows per page
- Edit cells in MySQL, PostgreSQL and OpenSearch results
- Cancel a running query
- Download every row as CSV or JSON
- Passwords are kept in the OS keychain
- Follows your VS Code color theme, light or dark
- Open tabs and their queries come back the next time you open AnyQuery

## Install

Search for **AnyQuery** in the Extensions view. It is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=seller-note.anyquery) and on [Open VSX](https://open-vsx.org/extension/seller-note/anyquery) for Cursor, Windsurf and VSCodium. Needs VS Code 1.101 or later.

## Usage

1. Click the AnyQuery icon in the Activity Bar, or run `AnyQuery: Open` from the Command Palette.
2. Click `+` to add a connection. Click `Test connection` to check it first.
3. Expand the connection and click a table, collection, key or index to query it in a new tab.
4. Press `Cmd+Enter` (`Ctrl+Enter` on Windows and Linux) to run. If text is selected, only the selection runs. Click `Cancel` to stop.
5. Use `Previous` and `Next` above the results to change pages. Click a column header to sort the page.
6. Double-click a cell to see its full value, or to edit it. Click `Save` to save your changes.
7. Click `Download` to save every row as CSV or JSON.

## Query syntax

| Database | Syntax | Example |
|---|---|---|
| MySQL | SQL. Statements separated by `;` run in order and stop at the first error. For procedure and trigger bodies, use `DELIMITER //` like the mysql client. | `SELECT * FROM users LIMIT 10;` |
| PostgreSQL | SQL. Statements separated by `;` run in order and stop at the first error. `;` inside `$$` bodies does not split. | `SELECT * FROM users LIMIT 10;` |
| MongoDB | mongosh-style JavaScript. `show dbs` and `show collections` work too. | `db.users.find({ age: { $gt: 20 } }).limit(20)` |
| Redis | One command per line, like redis-cli | `HGETALL user:1` |
| OpenSearch | Kibana Dev Tools syntax: a request line, then a JSON body | `GET /books/_search` |

Each tab has its own MySQL or PostgreSQL connection, so variables and transactions carry over between runs in the tab.

## Good to know

- Until every row of a large MySQL or PostgreSQL result (over 5,000 rows) is read, the tab's connection is busy and the table can stay locked. The result closes if you don't read a page for 5 minutes.
- If the tab has an open transaction, saved cell edits join it. Run `COMMIT` yourself.
- Canceling in PostgreSQL aborts an open transaction. Run `ROLLBACK` to continue.
- Closing the AnyQuery panel closes every connection.

For paging, editing and canceling in each database, see [How AnyQuery works](docs/details.md).

## Limitations

Not supported yet: SSH tunnels, AWS SigV4 auth for OpenSearch, Redis Cluster and Sentinel, and editing MongoDB and Redis results.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to build it from source.

## License

[MIT](LICENSE)
