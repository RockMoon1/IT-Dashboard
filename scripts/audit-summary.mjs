// Prints `npm audit` as one line per vulnerable package: severity, how it is pulled in, and
// whether a non-breaking fix exists. Report only: it always exits 0, so CI shows the list
// without failing on advisories in build tools.
import { execFileSync } from 'node:child_process'

let raw = ''
try {
  raw = execFileSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore']
  })
} catch (err) {
  raw = err.stdout ?? '' // npm audit exits 1 when it finds anything
}

let report
try {
  report = JSON.parse(raw)
} catch {
  console.log('npm audit returned no JSON (offline or registry error)')
  process.exit(0)
}

const vulns = Object.values(report.vulnerabilities ?? {})
const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 }
vulns.sort(
  (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.name.localeCompare(b.name)
)
console.log(`npm audit: ${JSON.stringify(report.metadata?.vulnerabilities ?? {})}`)
for (const v of vulns) {
  const via = v.via.map((x) => (typeof x === 'string' ? x : `${x.title} (${x.url})`)).join('; ')
  const fix =
    v.fixAvailable === true
      ? 'fix: npm audit fix'
      : v.fixAvailable
        ? `fix needs ${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
        : 'no fix yet'
  console.log(
    `- ${v.severity.padEnd(8)} ${v.name} ${v.range} · ${v.isDirect ? 'direct dependency' : `affects ${v.effects?.join(', ') || 'no other package'}`} · ${fix}\n    ${via}`
  )
}
