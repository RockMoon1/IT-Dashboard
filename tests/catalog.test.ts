import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allCatalogs,
  customCommands,
  getCommands
} from '../src/main/services/diagnostics/catalog.ts'
import { PURPOSES } from '../src/shared/types.ts'

test('every purpose has a command set for Windows, macOS and Linux', () => {
  const catalogs = allCatalogs()
  const purposes = PURPOSES.filter((p) => p.id !== 'other').map((p) => p.id)
  for (const os of ['windows', 'macos', 'linux'] as const) {
    for (const purpose of purposes) {
      const entry = catalogs.find((c) => c.os === os && c.purpose === purpose)
      assert.ok(entry, `${os}/${purpose} missing`)
      assert.ok(
        entry.commands.length >= 2,
        `${os}/${purpose} has ${entry.commands.length} command(s)`
      )
      const ids = entry.commands.map((c) => c.id)
      assert.equal(new Set(ids).size, ids.length, `${os}/${purpose} has duplicate ids`)
      assert.ok(
        entry.commands.some((c) => !c.optional),
        `${os}/${purpose} has no required command`
      )
      for (const c of entry.commands) {
        assert.ok(c.script.trim().length > 0, `${c.id} has an empty script`)
        assert.equal(c.shell, os === 'windows' ? 'powershell' : 'sh')
        assert.ok(!c.script.includes('${'), `${c.id} contains a template placeholder`)
        if (c.shell === 'powershell')
          assert.ok(!c.script.includes('`'), `${c.id} contains a backtick`)
        if (c.format === 'json')
          assert.ok(
            c.script.includes('ConvertTo-Json'),
            `${c.id} is json but never calls ConvertTo-Json`
          )
      }
    }
  }
})

test('json scripts build arrays with -InputObject so single items stay arrays on PowerShell 5.1', () => {
  for (const { commands } of allCatalogs()) {
    for (const c of commands) {
      if (c.format !== 'json') continue
      assert.ok(/ConvertTo-Json -InputObject/.test(c.script), `${c.id} pipes into ConvertTo-Json`)
    }
  }
})

test('unknown OS gets the Linux set; WinRM-only purposes resolve to Windows scripts', () => {
  assert.deepEqual(
    getCommands('system-diagnostics', 'unknown'),
    getCommands('system-diagnostics', 'linux')
  )
  assert.equal(getCommands('security-check', 'windows')[0]?.shell, 'powershell')
})

test('custom commands skip blanks and comments and use the OS shell', () => {
  const cmds = customCommands(['  Get-Service Spooler ', '', '# comment', 'whoami'], 'windows')
  assert.deepEqual(
    cmds.map((c) => [c.id, c.script, c.shell]),
    [
      ['custom-1', 'Get-Service Spooler', 'powershell'],
      ['custom-2', 'whoami', 'powershell']
    ]
  )
  assert.equal(getCommands('other', 'macos', ['uname -a'])[0]?.shell, 'sh')
  assert.equal(getCommands('other', 'windows', []).length, 0)
})
