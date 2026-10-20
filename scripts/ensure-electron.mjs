// Runs before `npm run dev` / `npm start`. The electron npm package is only a launcher: its own
// install step downloads the Electron program (about 110 MB) and records it in
// node_modules/electron/path.txt. If that download failed or was skipped during `npm install`,
// electron-vite stops with "Error: Electron uninstall". This script notices that, runs the
// download again with its output visible, and explains what to do if it still fails.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let dir
try {
  dir = dirname(require.resolve('electron/package.json'))
} catch {
  console.error('Electron is not installed in this folder. Run: npm install')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
const pathFile = join(dir, 'path.txt')

function installed() {
  if (!existsSync(pathFile)) return false
  const exe = readFileSync(pathFile, 'utf8').trim()
  return exe.length > 0 && existsSync(join(dir, 'dist', exe))
}

if (installed()) process.exit(0)

console.log(
  `Electron ${version} is installed, but its program was not downloaded. Downloading it now (about 110 MB)...`
)
const env = { ...process.env }
delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
const result = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit', env })

if (result.status === 0 && installed()) {
  console.log(`Electron ${version} is ready.`)
  process.exit(0)
}

console.error(`
The Electron download did not finish (exit ${result.status ?? result.signal}). The message above says why.
Common causes and fixes, in this folder:
  - No internet, or a proxy: retry on a direct connection, then run  npm run dev  again.
  - A half-finished download in the cache: delete the folder
      %LOCALAPPDATA%\\electron\\Cache
    then run  npm run dev  again.
  - Antivirus removed electron.exe: allow this folder, then run
      Remove-Item -Recurse -Force node_modules\\electron
      npm install
`)
process.exit(1)
