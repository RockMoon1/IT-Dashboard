import { app, type BrowserWindow } from 'electron'

/**
 * Launch test, used by CI on the packaged app (ARH_SMOKE=1). It drives the real window the way
 * a technician would: wait for the dashboard, call the lookup through the preload bridge, type a
 * computer name into the header box, press Enter, check the computer page, then open every tab.
 * It only reads; the vault it points at is a copy of the test fixture. Exits 0 when everything
 * rendered without a crash or console error, 1 otherwise, and prints a JSON report.
 */

const RENDERER_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, fn, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const v = fn()
      if (v) return v
      await sleep(100)
    }
    throw new Error('timed out waiting for ' + what)
  }
  const text = () => document.body.innerText
  const out = {}
  await until('the dashboard title', () => document.querySelector('h1')?.textContent?.includes('ARH IT Dashboard'))
  out.bridge = typeof window.arh === 'object' && typeof window.arh.lookup?.search === 'function'

  const lk = await window.arh.lookup.search('ARH-T01')
  out.lookup = { computers: lk.computers.map((c) => c.name), vaultNotes: lk.vaultNotes, ms: lk.tookMs }

  const input = await until('the lookup box', () => document.querySelector('input[aria-label="Look up a computer"]'))

  // Enter straight after typing a room name, before any result is back: still the computer
  input.focus()
  input.value = 'front desk'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until('the computer page from a room name', () => [...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'ARH-T01'))
  out.enterBeforeResults = !text().includes('Not a known computer')
  const back = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('All computers'))
  back?.click()
  await until('the computers list again', () => text().includes('Computers on record'))

  input.focus()
  input.value = 'ARH-T01'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  // a real computer row in the dropdown, not just the "Everything in the vault" row
  await until('a computer row in the lookup list', () =>
    [...document.querySelectorAll('div.z-50 button')].some(
      (b) => b.textContent.includes('ARH-T01') && !b.textContent.includes('Everything in the vault')
    )
  )
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until('the computer page', () => [...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'ARH-T01'))
  await until('the ticket on the page', () => text().includes('TKT-2026-901'))
  out.profile = {
    ticket: text().includes('TKT-2026-901'),
    workLog: text().includes('ARH-T01 battery check'),
    loop: text().includes('order a replacement battery'),
    change: text().includes('Disabled wake timers'),
    note: text().includes('Loaner notes')
  }

  // Notes open inside the dashboard, not in Obsidian
  const viewer = () => document.querySelector('[aria-label="Note viewer"]')
  const viewerText = () => viewer()?.innerText ?? ''
  const viewerTitle = () => viewer()?.querySelector('header p.text-sm')?.textContent?.trim() ?? ''
  const viewerButton = (label) =>
    [...(viewer()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === label)
  const row = (needle) => [...document.querySelectorAll('li')].find((li) => li.textContent.includes(needle))
  const closeViewer = async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until('the viewer to close', () => !viewer())
  }
  row('battery will not hold a charge')?.click()
  await until('the ticket in the note viewer', () => viewerText().includes('Synthetic ticket for the lookup tests'))
  out.viewer = {
    properties: !!viewer()?.querySelector('dl') && viewerText().includes('TKT-2026-901'),
    taskBoxes: viewerText().includes('☐') && viewerText().includes('☑'),
    obsidianIsOnlyAButton: !!viewerButton('Open in Obsidian ↗')
  }
  await closeViewer()
  row('order a replacement battery')?.click()
  await until('Open Loops with the clicked line marked', () =>
    viewer()?.querySelector('.md-hit')?.textContent?.includes('order a replacement battery')
  )
  out.viewer.lineMarked = true
  viewerButton('ARH Work Log')?.click()
  await until('the Work Log after following [[ARH Work Log]]', () => viewerTitle() === 'ARH Work Log')
  out.viewer.wikilink = true
  viewer()?.querySelector('button[title^="Back"]')?.click()
  await until('Back to Open Loops', () => viewerTitle() === 'ARH Open Loops')
  out.viewer.back = true
  await closeViewer()

  // Phase 3: the shipped actions reach the page, and Settings shows Access and control with one
  // switch per action (nothing runs: there is no device in the launch test)
  const catalog = await window.arh.actions.catalog()
  out.actions = {
    catalog: catalog.length,
    hashed: catalog.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)),
    measureAndApply: catalog.every((a) => a.measure.length > 0 && a.apply.length > 0)
  }
  ;[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Settings')?.click()
  await until('Access and control in Settings', () => text().includes('Access and control'))
  out.actions.settingsSwitches = await until('one switch per action', () => {
    const n = document.querySelectorAll('details label input[type="checkbox"]').length
    return n >= catalog.length && n
  })
  ;[...document.querySelectorAll('form button')].find((b) => b.textContent.trim() === 'Cancel')?.click()
  await until('Settings to close', () => !text().includes('Access and control'))

  // "Computers" twice: the first click returns to the open computer page, the second to the list
  const tabs = ['Active scan', 'Results', 'Health', 'Open loops', 'Work log', 'Search', 'Link', 'Computers', 'Computers']
  out.tabs = {}
  for (const label of tabs) {
    const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.trim().startsWith(label))
    if (!b) { out.tabs[label] = 'missing'; continue }
    b.click()
    await sleep(400)
    const pane = document.querySelector('main section > div.overflow-y-auto')
    out.tabs[label] = !b.classList.contains('tab-active')
      ? 'not selected'
      : (pane?.innerText.trim().length ?? 0) > 0
        ? 'ok'
        : 'blank'
  }
  out.list = await until('the computers list', () => text().includes('Computers on record') && 'ok')
  out.banner = document.querySelector('.bg-bad-400\\/10')?.textContent?.trim() ?? null
  return JSON.stringify(out)
})()`

export function runSmoke(win: BrowserWindow): void {
  const problems: string[] = []
  const consoleErrors: string[] = []
  const finish = (report: unknown): void => {
    const ok = problems.length === 0 && consoleErrors.length === 0
    process.stdout.write(
      `ARH_SMOKE ${JSON.stringify({ ok, report, problems, consoleErrors }, null, 2)}\n`
    )
    app.exit(ok ? 0 : 1)
  }
  const timer = setTimeout(() => {
    problems.push('timed out after 90 s')
    finish(null)
  }, 90_000)

  // The listener signature changed across Electron versions; read both shapes.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown } | undefined
    const level = first && typeof first === 'object' && 'level' in first ? first.level : args[1]
    const message =
      first && typeof first === 'object' && 'message' in first ? first.message : args[2]
    if (level === 'error' || level === 3) consoleErrors.push(String(message))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`renderer gone: ${details.reason}`)
    finish(null)
  })
  win.webContents.on('preload-error', (_e, path, error) => {
    problems.push(`preload error in ${path}: ${error.message}`)
  })
  win.webContents.once('did-finish-load', () => {
    win.webContents
      .executeJavaScript(RENDERER_SCRIPT, true)
      .then((json: string) => {
        clearTimeout(timer)
        const report = JSON.parse(json) as Record<string, unknown>
        const profile = report['profile'] as Record<string, boolean> | undefined
        if (!report['bridge']) problems.push('preload bridge missing')
        if (!report['enterBeforeResults'])
          problems.push('Enter before the lookup answered opened a notes-only page')
        if (report['banner']) problems.push(`error banner shown: ${String(report['banner'])}`)
        for (const [k, v] of Object.entries(profile ?? {}))
          if (!v) problems.push(`computer page is missing its ${k}`)
        const viewer = report['viewer'] as Record<string, boolean> | undefined
        for (const k of [
          'properties',
          'taskBoxes',
          'obsidianIsOnlyAButton',
          'lineMarked',
          'wikilink',
          'back'
        ])
          if (!viewer?.[k]) problems.push(`note viewer check failed: ${k}`)
        const acts = report['actions'] as Record<string, number | boolean> | undefined
        if (!acts || Number(acts['catalog']) < 20)
          problems.push(`only ${String(acts?.['catalog'])} actions loaded`)
        if (!acts?.['hashed'] || !acts['measureAndApply'])
          problems.push('an action has no hash or lacks a measure or apply script')
        if (!acts?.['settingsSwitches']) problems.push('Settings shows no per-action switches')
        for (const [k, v] of Object.entries((report['tabs'] as Record<string, string>) ?? {}))
          if (v !== 'ok') problems.push(`tab ${k}: ${v}`)
        finish(report)
      })
      .catch((err: unknown) => {
        clearTimeout(timer)
        problems.push(`renderer script failed: ${err instanceof Error ? err.message : String(err)}`)
        finish(null)
      })
  })
}
