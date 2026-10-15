import { test } from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  decodeCrockford,
  encodeCrockford,
  formatToken,
  parseToken,
  proof,
  proofEqual,
  TokenStore,
  TOKEN_TTL_MS
} from '../src/main/services/link/tokens.ts'
import { LineSplitter, encode } from '../src/main/services/link/ndjson.ts'
import { DeviceStore } from '../src/main/services/link/devices.ts'
import { LinkServer, type LinkEvent } from '../src/main/services/link/server.ts'
import { beaconPayload, directedBroadcast } from '../src/main/services/link/beacon.ts'
import { makeCert } from './helpers/certs.ts'

// Shared known answer with agent/internal/protocol/protocol_test.go (TestProofKnownAnswer).
const KNOWN_PROOF = 'ca94f54ce077da0f58017f8b4ff9a7227b5057cc8ce6e332441adab22ef63d69'

test('crockford base32 and token format match the agent', () => {
  const secret = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const enc = encodeCrockford(secret)
  assert.equal(enc.length, 16)
  assert.deepEqual([...decodeCrockford(enc.toLowerCase())], [...secret])
  assert.deepEqual([...decodeCrockford('0ILO')], [...decodeCrockford('0110')])
  const token = formatToken('3f9a1c2b', secret)
  assert.equal(token, 'ARH-3F9A1C2B-' + enc)
  const parsed = parseToken(' ' + token.toLowerCase() + ' ')
  assert.equal(parsed.fp8, '3F9A1C2B')
  assert.deepEqual([...parsed.secret], [...secret])
  assert.throws(() => parseToken('ARH-ZZZZZZZZ-' + enc), /hex/)
  assert.throws(() => parseToken('nope'), /must look like/)
})

test('HMAC proof matches the Go implementation byte for byte', () => {
  const secret = Uint8Array.from(Buffer.from('000102030405060708090a', 'hex').subarray(0, 10))
  const nonce = Uint8Array.from(Buffer.from('0a0b0c0d', 'hex'))
  assert.equal(proof(secret, nonce, 'ABCDEF'), KNOWN_PROOF)
  assert.ok(proofEqual(proof(secret, nonce, 'abcdef'), KNOWN_PROOF.toUpperCase()))
  assert.ok(!proofEqual(proof(Uint8Array.from([1]), nonce, 'abcdef'), KNOWN_PROOF))
})

test('token store is single use and time limited', () => {
  let now = 1_000_000
  const store = new TokenStore(() => now)
  const issued = store.issue('abcdef0123456789', 'Front desk laptop')
  assert.ok(issued.token.startsWith('ARH-ABCDEF01-'))
  assert.equal(store.peek(issued.token)?.label, 'Front desk laptop')
  assert.equal(store.active().length, 1)
  assert.equal(store.consume(issued.token), true)
  assert.equal(store.consume(issued.token), false, 'second use refused')
  const t2 = store.issue('abcdef0123456789')
  now += TOKEN_TTL_MS + 1
  assert.equal(store.peek(t2.token), null, 'expired')
  assert.equal(store.peek('garbage'), null)
})

test('ndjson splitter handles partial chunks, CRLF and oversized lines', () => {
  const got: string[] = []
  const errs: string[] = []
  const s = new LineSplitter(
    (m) => got.push(m.type),
    (e) => errs.push(e.message)
  )
  s.push('{"type":"a"}\r\n{"ty')
  s.push('pe":"b"}\n\n{"notype":1}\nnot json\n')
  assert.deepEqual(got, ['a', 'b'])
  assert.equal(errs.length, 2)
  s.push('x'.repeat(300 * 1024))
  assert.equal(errs.length, 3)
  assert.equal(encode({ type: 'ping' }), '{"type":"ping"}\n')
})

test('beacon payload and directed broadcast', () => {
  assert.deepEqual(
    JSON.parse(
      beaconPayload({ tlsPort: 47912, hostFingerprint: 'ABCDEF0123456789abcd', hostId: 'h1' })
    ),
    { arh: 1, port: 47912, fp: 'abcdef0123456789', hostId: 'h1' }
  )
  assert.equal(directedBroadcast('169.254.10.20', 16), '169.254.255.255')
  assert.equal(directedBroadcast('192.168.1.5', 24), '192.168.1.255')
  assert.equal(directedBroadcast('bad', 24), null)
})

function connectClient(
  port: number,
  cert: { certPem: string; keyPem: string }
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        cert: cert.certPem,
        key: cert.keyPem,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3'
      },
      () => resolve(socket)
    )
    socket.once('error', reject)
  })
}

function lines(socket: tls.TLSSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<(m: Record<string, unknown>) => void> = []
  const splitter = new LineSplitter(
    (m) => {
      const w = waiters.shift()
      if (w) w(m)
      else queue.push(m)
    },
    () => undefined
  )
  socket.setEncoding('utf8')
  socket.on('data', (d: string) => splitter.push(d))
  return () =>
    new Promise((resolve, reject) => {
      const q = queue.shift()
      if (q) return resolve(q)
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 5000)
      waiters.push((m) => {
        clearTimeout(timer)
        resolve(m)
      })
    })
}

test('link server: enrollment with proof, reconnection, rejection of unknown devices, message relay', async (t) => {
  const host = makeCert('test-dashboard')
  const device = makeCert('unit-device')
  const stranger = makeCert('stranger')
  if (!host || !device || !stranger) {
    t.skip('agent binary or go toolchain not available to mint test certificates')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'arh-link-'))
  const events: LinkEvent[] = []
  const devices = new DeviceStore(join(dir, 'devices.json'))
  await devices.load()
  const tokens = new TokenStore()
  const server = new LinkServer({
    certPem: host.certPem,
    keyPem: host.keyPem,
    hostFingerprint: host.fingerprint,
    hostId: 'h',
    devices,
    tokens,
    port: 0
  })
  server.onEvent((e) => events.push(e))
  const port = await server.start()
  try {
    // 1. unknown device says hello → rejected
    const s0 = await connectClient(port, stranger)
    const next0 = lines(s0)
    s0.write(encode({ type: 'hello', hostname: 'x', serial: 's', os: 'linux', agentVersion: 't' }))
    assert.equal((await next0())['type'], 'reject')
    s0.destroy()

    // 2. enrollment
    const issued = tokens.issue(host.fingerprint, 'Front desk')
    const s1 = await connectClient(port, device)
    const next1 = lines(s1)
    const nonce = randomBytes(32)
    s1.write(
      encode({
        type: 'enroll',
        token: issued.token,
        nonce: nonce.toString('base64'),
        hostname: 'LAPTOP-01',
        serial: 'SER1',
        os: 'windows',
        agentVersion: '0.2.0',
        profiles: [{ name: 'windows-system-diagnostics', version: 1 }]
      })
    )
    const proofMsg = await next1()
    assert.equal(proofMsg['type'], 'enroll-proof')
    assert.equal(proofMsg['hostFingerprint'], host.fingerprint)
    assert.equal(proofMsg['proof'], proof(issued.secret, nonce, host.fingerprint))
    s1.write(encode({ type: 'enroll-confirm' }))
    const enrolled = await next1()
    assert.equal(enrolled['type'], 'enrolled')
    const expectedId = createHash('sha256')
      .update(Buffer.from(device.certPem.replace(/-----[^-]+-----/g, ''), 'base64'))
      .digest('hex')
    assert.equal(
      enrolled['deviceId'],
      expectedId,
      'device id is the client certificate fingerprint'
    )
    assert.equal(
      enrolled['displayName'],
      'Front desk',
      'label from the token becomes the display name'
    )
    assert.equal(tokens.consume(issued.token), false, 'token consumed by enrollment')
    assert.equal(devices.get(expectedId)?.serial, 'SER1')
    assert.ok(server.isConnected(expectedId))

    // 3. relay a scan message both ways
    assert.ok(
      server.send(expectedId, {
        type: 'run',
        runId: 'r1',
        profile: 'windows-system-diagnostics',
        version: 1
      })
    )
    assert.equal((await next1())['runId'], 'r1')
    s1.write(
      encode({ type: 'check-output', runId: 'r1', checkId: 'c', stream: 'stdout', data: 'hi' })
    )
    await new Promise((r) => setTimeout(r, 50))
    const relayed = events.find((e) => e.type === 'message')
    assert.equal(relayed?.type === 'message' ? relayed.message['data'] : null, 'hi')
    s1.write(encode({ type: 'ping' }))
    assert.equal((await next1())['type'], 'pong')
    s1.destroy()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!server.isConnected(expectedId))

    // 4. reconnection with hello is welcomed and refreshes metadata
    const s2 = await connectClient(port, device)
    const next2 = lines(s2)
    s2.write(
      encode({
        type: 'hello',
        hostname: 'LAPTOP-01',
        serial: 'SER1',
        os: 'windows',
        agentVersion: '0.2.1',
        profiles: [{ name: 'windows-security-check', version: 1 }]
      })
    )
    const welcome = await next2()
    assert.equal(welcome['type'], 'welcome')
    assert.equal(welcome['deviceId'], expectedId)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(devices.get(expectedId)?.agentVersion, '0.2.1')
    assert.deepEqual(devices.get(expectedId)?.profiles, [
      { name: 'windows-security-check', version: 1 }
    ])
    s2.destroy()

    // 5. the same machine reinstalls the agent (new key, same serial): the record moves to the new key
    const reinstalled = makeCert('unit-device-reinstalled')!
    const issued2 = tokens.issue(host.fingerprint)
    const s4 = await connectClient(port, reinstalled)
    const next4 = lines(s4)
    const nonce2 = randomBytes(32)
    s4.write(
      encode({
        type: 'enroll',
        token: issued2.token,
        nonce: nonce2.toString('base64'),
        hostname: 'LAPTOP-01',
        serial: 'SER1',
        os: 'windows',
        agentVersion: '0.2.2',
        profiles: []
      })
    )
    assert.equal((await next4())['type'], 'enroll-proof')
    s4.write(encode({ type: 'enroll-confirm' }))
    const enrolled2 = await next4()
    assert.equal(
      enrolled2['displayName'],
      'Front desk',
      'name carried over from the matched record'
    )
    assert.notEqual(enrolled2['deviceId'], expectedId)
    assert.equal(devices.get(expectedId), undefined, 'old key record removed')
    assert.equal(devices.list().length, 1)
    s4.destroy()

    // 6. a bad token is rejected without consuming anything
    const s3 = await connectClient(port, stranger)
    const next3 = lines(s3)
    s3.write(
      encode({
        type: 'enroll',
        token: 'ARH-00000000-0000000000000000',
        nonce: randomBytes(32).toString('base64')
      })
    )
    assert.equal((await next3())['type'], 'reject')
    s3.destroy()
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(
      events.map((e) => e.type),
      [
        'listening',
        'rejected',
        'enrolled',
        'message',
        'disconnected',
        'connected',
        'disconnected',
        'enrolled',
        'disconnected',
        'rejected'
      ]
    )
  } finally {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
