# Contributing

Issues and pull requests are welcome. AnyQuery is built with React and TypeScript.

## Build from source

You need Node.js 20.19+ or 22.12+, and pnpm. npm works too.

```bash
git clone https://github.com/sellernote/anyquery.git
cd anyquery
pnpm install
pnpm install:package  # builds, packages and installs it into VS Code
```

Then run `Developer: Reload Window` in VS Code to load the new version. Run the same command again after you change the code. It needs the `code` command in your PATH (in VS Code, run `Shell Command: Install 'code' command in PATH`).

To make a `.vsix` file to share, run `pnpm package`. It writes `anyquery-<version>.vsix`.

## Development

Open the folder in VS Code and press `F5`. It builds the extension and opens a new VS Code window with it loaded. Run `pnpm watch` to rebuild on every change, then run `Developer: Reload Webviews` or reload the window.

Before you open a pull request, run `pnpm typecheck` and `pnpm test`. CI runs both on every pull request. Tests sit next to the code they test, as `*.test.ts`, and use Node's built-in test runner.

## Releasing

For maintainers. Bump `version` in `package.json`, commit it, then push a matching tag:

```bash
git tag -a v0.3.1 -m v0.3.1
git push origin main v0.3.1
```

The Release workflow then publishes the extension to the VS Code Marketplace and Open VSX, and attaches the `.vsix` to a GitHub release.

It needs no tokens. Both stores trust the workflow through Trusted Publishing, set up once with owner `sellernote`, repository `anyquery`, workflow `release.yml` and no environment:

- **Marketplace**: open the `seller-note` publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and select **Trusted Publishing**.
- **Open VSX**: open [Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers) as an owner of the `seller-note` namespace.

To publish an existing tag again, run the Release workflow by hand from the Actions tab with that tag. Versions already published are skipped.

## Project structure

```
src/
  shared/           Code shared by the extension and the UI
    rpc.ts          Message format between the webview and the extension
  extension/        Runs in the VS Code extension host
    index.ts        Opens the panel and answers webview requests
    store.ts        Saved connections (passwords and URIs in SecretStorage)
    cursors.ts      Cursors for reading more pages
    drivers/        One driver per database
  webview/          React UI shown in the panel
    api.ts          Calls the extension
scripts/
  build.mjs         Bundles both parts with esbuild
  test.mjs          Runs the tests
```

All database access happens in the extension. The UI runs in a webview and talks to it only through messages (`webview/api.ts`). Each method of the `Api` interface in `shared/types.ts` is handled by the function of the same name in `extension/index.ts`.

## Adding a database

1. Implement the `Driver` interface (`drivers/types.ts`) in `src/extension/drivers/`.
   - If a result has more than one page, return only the first page with a `cursor`. For results already in memory, use `paginate()` (`drivers/util.ts`).
   - Stop running when `ctx.signal` aborts, so `Cancel` works. `runAll()` and `cancelable()` in `drivers/util.ts` help.
   - To support editing, set `edit` on results and implement `saveEdits`. SQL databases can use `drivers/sqlEdits.ts`.
   - For autocomplete, implement `completions`.
2. Register it in `createDriver` in `drivers/index.ts`.
3. Add it to `DbType`, `DEFAULT_PORTS` and `DB_LABELS` in `shared/types.ts`.
4. Add syntax highlighting in `languageFor` in `webview/components/Editor.tsx`.
