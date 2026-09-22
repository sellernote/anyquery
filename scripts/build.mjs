// Bundles the extension (Node) and the webview (browser) with esbuild.
//   node scripts/build.mjs               development build
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --production  minified, no source maps
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const production = process.argv.includes('--production')

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info'
}

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/index.ts'],
    outfile: 'out/extension.js',
    tsconfig: 'tsconfig.extension.json',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: [
      'vscode',
      // Optional pg packages for native bindings and Cloudflare Workers
      'pg-native',
      'pg-cloudflare',
      // Optional MongoDB packages. The driver works without them.
      '@aws-sdk/credential-providers',
      '@mongodb-js/zstd',
      'gcp-metadata',
      'kerberos',
      'mongodb-client-encryption',
      'snappy',
      'socks'
    ]
  },
  {
    ...common,
    entryPoints: ['src/webview/main.tsx'],
    // styles.css is written next to it as index.css
    outfile: 'out/webview/index.js',
    tsconfig: 'tsconfig.webview.json',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120'
  }
]

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
