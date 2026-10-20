import { test } from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResult } from '../src/shared/actions.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings-defaults.ts'
import { ActionCatalog } from '../src/main/services/actions/catalog.ts'
import { ActionLog } from '../src/main/services/actions/log.ts'
import { ActionRunner } from '../src/main/services/actions/runner.ts'
import { DeviceStore, type EnrolledDevice } from '../src/main/services/link/devices.ts'
import { LineSplitter, encode, type LinkMessage } from '../src/main/services/link/ndjson.ts'
import { LinkServer } from '../src/main/services/link/server.ts'
import { DeviceSlots } from '../src/main/services/link/slots.ts'
import { TokenStore } from '../src/main/services/link/tokens.ts'
import { makeCert } from './helpers/certs.ts'

/*
  The dashboard side end to end over a real TLS socket: link server, capabilities from hello,
  action runner, and a fake agent that answers the way agent/internal/link/actions.go does.
*/

type Msg = Record<string, unknown>

function connect(port: number, cert: { certPem: string; keyPem: string }): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      {
        host: '127.0.0.1',
        port,
        cert: cert.certPem,
        key: cert.keyPem,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3'
      },
      () => resolve(s)
    )
    s.once('error', reject)
  })
}

/** Reads messages, skipping pings, until one matches. */
function reader(socket: tls.TLSSocket): (type: string) => Promise<Msg> {
  const queue: Msg[] = []
  const waiters: Array<() => void> = []
  const splitter = new LineSplitter(
    (m) => {
      queue.push(m)
      waiters.splice(0).forEach((w) => w())
    },
    () => undefined
  )
  socket.setEncoding('utf8')
  socket.on('data', (d: string) => splitter.push(d))
  return async (type) => {
    const t0 = Date.now()
    for (;;) {
      const i = queue.findIndex((m) => m['type'] === type)
      if (i >= 0) return queue.splice(i, 1)[0]!
      if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${type}`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 100)
      })
    }
  }
}

const until = async (what: string, fn: () => boolean): Promise<void> => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('actions end to end: preview, run, cable pulled mid-change, late result, acks, policy change', async (t) => {
  const host = makeCert('test-dashboard')
  const agentCert = makeCert('unit-device')
  if (!host || !agentCert) {
    t.skip('agent binary or go toolchain not available to mint test certificates')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'arh-actions-link-'))
  const catalog = new ActionCatalog()
  await catalog.load(join(import.meta.dirname, '..', 'actions'))
  const deviceId = createHash('sha256')
    .update(Buffer.from(agentCert.certPem.replace(/-----[^-]+-----/g, ''), 'base64'))
    .digest('hex')
  const devices = new DeviceStore(join(dir, 'devices.json'))
  await devices.load()
  const device: EnrolledDevice = {
    id: deviceId,
    serial: '5CG1234XYZ',
    hostname: 'ARH-FD01',
    os: 'windows',
    displayName: 'Front desk 1',
    enrolledAt: '2026-10-01T00:00:00Z',
    lastSeen: '2026-10-20T00:00:00Z',
    agentVersion: '0.3.0',
    profiles: []
  }
  await devices.upsert(device)
  const server = new LinkServer({
    certPem: host.certPem,
    keyPem: host.keyPem,
    hostFingerprint: host.fingerprint,
    hostId: 'h',
    devices,
    tokens: new TokenStore(),
    port: 0
  })
  const runner = new ActionRunner({
    catalog,
    log: new ActionLog(join(dir, 'actions.jsonl')),
    slots: new DeviceSlots(),
    send: (id, m) => server.send(id, m),
    capabilities: (id) => server.capabilities(id),
    settings: () => ({ ...DEFAULT_SETTINGS, technician: 'Lisandro' }),
    reconnectGraceMs: 2000
  })
  server.onEvent((e) => {
    if (e.type === 'message') runner.handleMessage(e.deviceId, e.message)
    if (e.type === 'connected') runner.deviceConnected(e.device.id)
    if (e.type === 'disconnected') runner.deviceLost(e.deviceId)
  })
  const port = await server.start()
  const hello = (running = ''): LinkMessage => ({
    type: 'hello',
    hostname: 'ARH-FD01',
    serial: '5CG1234XYZ',
    os: 'windows',
    agentVersion: '0.3.0',
    profiles: [],
    protocol: 2,
    link: 'cable',
    actions: catalog
      .forOs('windows')
      .map((a) => ({ name: a.name, version: a.version, sha256: a.sha256 })),
    policy: {
      schema: 'arh-policy/1',
      write: true,
      execute: true,
      custom: false,
      lan: false,
      interrupts: true,
      deny: []
    },
    ...(running ? { running } : {})
  })
  const flush = catalog.get('windows-dns-flush')!
  const result = (runId: string, over: Partial<AgentResult>): AgentResult => ({
    runId,
    kind: 'action',
    action: flush.name,
    version: flush.version,
    sha256: flush.sha256,
    access: 'execute',
    params: {},
    dryRun: false,
    applied: true,
    startedAt: '2026-10-20T20:05:00Z',
    before: {
      items: [{ item: 'Cached DNS entries', value: '41' }],
      change: true,
      plan: 'Clear the DNS cache',
      exitCode: 0
    },
    ...over
  })
  try {
    let sock = await connect(port, agentCert)
    let next = reader(sock)
    sock.write(encode(hello()))
    await next('welcome')
    await until('capabilities', () => server.capabilities(deviceId)?.link === 'cable')
    assert.deepEqual(runner.blockers(device, flush, 'apply'), [])

    // preview: the agent gets mode "preview", the action's hash, the reason and who
    const p = runner.preview(device, {
      deviceId,
      action: flush.name,
      params: {},
      reason: 'stale names'
    })
    const req = await next('action')
    assert.equal(req['mode'], 'preview')
    assert.equal(req['sha256'], flush.sha256)
    assert.equal(req['technician'], 'Lisandro')
    sock.write(encode({ type: 'run-start', runId: p.runId, mode: 'preview', link: 'cable' }))
    sock.write(
      encode({
        type: 'run-end',
        runId: p.runId,
        ok: true,
        result: result(p.runId, { dryRun: true, applied: false })
      })
    )
    assert.equal((await next('ack'))['runId'], p.runId)
    await until('the preview status', () => runner.get(p.runId)?.status === 'would-change')

    // run, then the cable is pulled once apply has started
    const r = runner.run(
      device,
      { deviceId, action: flush.name, params: {}, reason: 'stale names' },
      { previewOf: p.runId }
    )
    const applyReq = await next('action')
    assert.equal(applyReq['mode'], 'apply')
    sock.write(encode({ type: 'run-start', runId: r.runId, mode: 'apply', link: 'cable' }))
    sock.write(encode({ type: 'check-start', runId: r.runId, checkId: 'measure' }))
    sock.write(encode({ type: 'check-end', runId: r.runId, checkId: 'measure', exitCode: 0 }))
    sock.write(encode({ type: 'check-start', runId: r.runId, checkId: 'apply' }))
    await until('apply to be seen', () => !!runner.get(r.runId)?.appliedAt)
    sock.destroy()
    await until('outcome unknown', () => runner.get(r.runId)?.status === 'unknown')
    assert.throws(
      () => runner.preview(device, { deviceId, action: flush.name, params: {}, reason: 'x' }),
      /not connected|busy/,
      'the device is still working on the change'
    )

    // the device comes back and replays the result from its outbox; the dashboard acknowledges
    sock = await connect(port, agentCert)
    next = reader(sock)
    sock.write(encode(hello()))
    await next('welcome')
    const final = result(r.runId, {
      apply: { items: null, exitCode: 0 },
      after: { items: [{ item: 'Cached DNS entries', value: '0' }], change: true, exitCode: 0 },
      appliedAt: '2026-10-20T20:05:02Z',
      endedAt: '2026-10-20T20:05:04Z'
    })
    sock.write(encode({ type: 'result', runId: r.runId, result: final }))
    assert.equal((await next('ack'))['runId'], r.runId)
    await until('the late result', () => runner.get(r.runId)?.status === 'done')
    assert.equal(runner.get(r.runId)?.result?.after?.items?.[0]?.value, '0')

    // a policy changed on the device reaches the dashboard's gates at once
    sock.write(
      encode({
        type: 'policy',
        policy: {
          schema: 'arh-policy/1',
          write: false,
          execute: false,
          custom: false,
          lan: false,
          interrupts: false,
          deny: []
        }
      })
    )
    await until('the new policy', () => server.capabilities(deviceId)?.policy?.execute === false)
    assert.match(runner.blockers(device, flush, 'apply').join(), /refuses tasks/)
    sock.destroy()
  } finally {
    runner.stop()
    await runner.flush()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
