#!/usr/bin/env node
// Cross-compiles the Go agent into agent/dist for every supported target (or just the current
// machine with --host). Requires Go 1.22+. No module downloads: the agent uses the standard
// library only.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const hostOnly = process.argv.includes('--host')

const targets = [
  ['windows', 'amd64'],
  ['windows', 'arm64'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
  ['linux', 'amd64'],
  ['linux', 'arm64']
]
const current = [
  process.platform === 'win32' ? 'windows' : process.platform,
  process.arch === 'x64' ? 'amd64' : process.arch
]

mkdirSync(join(root, 'agent', 'dist'), { recursive: true })
for (const [os, arch] of hostOnly ? [current] : targets) {
  const ext = os === 'windows' ? '.exe' : ''
  const out = join(root, 'agent', 'dist', `arh-agent-${os}-${arch}${ext}`)
  execFileSync(
    'go',
    [
      'build',
      '-trimpath',
      '-ldflags',
      `-s -w -X main.version=${version}`,
      '-o',
      out,
      './agent/cmd/arh-agent'
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch }
    }
  )
  console.log(`built ${out}`)
}
