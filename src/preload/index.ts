import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ArhApi } from '../shared/api.ts'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ArhApi = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  devices: {
    list: () => ipcRenderer.invoke(IPC.devicesList),
    refresh: () => ipcRenderer.invoke(IPC.devicesRefresh),
    addManual: (host, label) => ipcRenderer.invoke(IPC.devicesAddManual, host, label),
    remove: (id) => ipcRenderer.invoke(IPC.devicesRemove, id),
    onChanged: (cb) => subscribe(IPC.devicesChanged, cb)
  },
  probe: {
    host: (host) => ipcRenderer.invoke(IPC.probeHost, host)
  },
  session: {
    start: (req) => ipcRenderer.invoke(IPC.sessionStart, req),
    abort: (sessionId) => ipcRenderer.invoke(IPC.sessionAbort, sessionId),
    get: (sessionId) => ipcRenderer.invoke(IPC.sessionGet, sessionId),
    onOutput: (cb) => subscribe(IPC.sessionOutput, cb),
    onDone: (cb) => subscribe(IPC.sessionDone, cb)
  },
  vault: {
    check: () => ipcRenderer.invoke(IPC.vaultCheck),
    append: (sessionId) => ipcRenderer.invoke(IPC.vaultAppend, sessionId),
    open: () => ipcRenderer.invoke(IPC.vaultOpen)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
  }
}

contextBridge.exposeInMainWorld('arh', api)
