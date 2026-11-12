// Bundles each src/**/*.test.ts with esbuild and runs them with Node's test runner.
//   node scripts/test.mjs
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const outdir = 'out/test'
rmSync(outdir, { recursive: true, force: true })

const { metafile } = await esbuild.build({
  entryPoints: ['src/**/*.test.ts'],
  outdir,
  outbase: 'src',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Database clients are loaded from node_modules, not bundled
  packages: 'external',
  tsconfig: 'tsconfig.extension.json',
  sourcemap: 'inline',
  metafile: true,
  logLevel: 'warning'
})

const files = Object.keys(metafile.outputs)
const { status } = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...files], { stdio: 'inherit' })
process.exit(status ?? 1)
