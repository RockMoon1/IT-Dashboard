/**
 * One run at a time per device, shared by scans, actions and custom commands, matching the
 * agent's single run slot. A slot is taken when a request is sent and released only when the
 * agent reports the end of that run (or a result after a reconnect), or when the request is
 * given up and recorded as such.
 */

export interface SlotHolder {
  runId: string
  kind: 'scan' | 'action' | 'exec'
  title: string
  startedAt: string
}

export class DeviceSlots {
  private held = new Map<string, SlotHolder>()

  holder(deviceId: string): SlotHolder | undefined {
    return this.held.get(deviceId)
  }

  /** Takes the slot or throws with what holds it. */
  take(deviceId: string, holder: SlotHolder, deviceName = 'this device'): void {
    const h = this.held.get(deviceId)
    if (h)
      throw new Error(
        `${deviceName} is busy with ${h.kind === 'scan' ? 'the scan' : h.kind === 'exec' ? 'a custom command' : 'the action'} "${h.title}" (run ${h.runId}, since ${h.startedAt})`
      )
    this.held.set(deviceId, holder)
  }

  /** Releases the slot if this run holds it. */
  release(deviceId: string, runId: string): void {
    if (this.held.get(deviceId)?.runId === runId) this.held.delete(deviceId)
  }
}
