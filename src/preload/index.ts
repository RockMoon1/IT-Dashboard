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
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    onLog: (cb) => subscribe(IPC.log, cb)
  },
  devices: {
    list: () => ipcRenderer.invoke(IPC.devicesList),
    remove: (id) => ipcRenderer.invoke(IPC.devicesRemove, id),
    rename: (id, displayName) => ipcRenderer.invoke(IPC.devicesRename, id, displayName),
    onChanged: (cb) => subscribe(IPC.devicesChanged, cb)
  },
  link: {
    status: () => ipcRenderer.invoke(IPC.linkStatus),
    refresh: () => ipcRenderer.invoke(IPC.linkRefresh),
    enableFirewall: () => ipcRenderer.invoke(IPC.linkEnableFirewall),
    onChanged: (cb) => subscribe(IPC.linkChanged, cb)
  },
  enroll: {
    create: (label) => ipcRenderer.invoke(IPC.enrollNew, label),
    cancel: (token) => ipcRenderer.invoke(IPC.enrollCancel, token),
    list: () => ipcRenderer.invoke(IPC.enrollList)
  },
  scan: {
    start: (deviceId, purpose) => ipcRenderer.invoke(IPC.scanStart, deviceId, purpose),
    abort: (runId) => ipcRenderer.invoke(IPC.scanAbort, runId),
    get: (runId) => ipcRenderer.invoke(IPC.scanGet, runId),
    list: () => ipcRenderer.invoke(IPC.scanList),
    history: (deviceId) => ipcRenderer.invoke(IPC.scanHistory, deviceId),
    onEvent: (cb) => subscribe(IPC.scanEvent, cb)
  },
  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList)
  },
  vault: {
    status: () => ipcRenderer.invoke(IPC.vaultStatus),
    preview: (runId) => ipcRenderer.invoke(IPC.vaultPreview, runId),
    apply: (runId) => ipcRenderer.invoke(IPC.vaultApply, runId),
    openLoops: () => ipcRenderer.invoke(IPC.vaultOpenLoops),
    workLog: (limit) => ipcRenderer.invoke(IPC.vaultWorkLog, limit),
    search: (query) => ipcRenderer.invoke(IPC.vaultSearch, query),
    open: () => ipcRenderer.invoke(IPC.vaultOpen),
    openNote: (file) => ipcRenderer.invoke(IPC.vaultOpenNote, file),
    readNote: (file) => ipcRenderer.invoke(IPC.vaultReadNote, file)
  },
  lookup: {
    search: (query) => ipcRenderer.invoke(IPC.lookupSearch, query),
    list: () => ipcRenderer.invoke(IPC.lookupList),
    profile: (target) => ipcRenderer.invoke(IPC.lookupProfile, target)
  },
  actions: {
    catalog: () => ipcRenderer.invoke(IPC.actionsCatalog),
    offers: (deviceId) => ipcRenderer.invoke(IPC.actionsOffers, deviceId),
    preview: (req) => ipcRenderer.invoke(IPC.actionsPreview, req),
    run: (req, confirm) => ipcRenderer.invoke(IPC.actionsRun, req, confirm),
    exec: (req) => ipcRenderer.invoke(IPC.actionsExec, req),
    abort: (runId) => ipcRenderer.invoke(IPC.actionsAbort, runId),
    list: (limit) => ipcRenderer.invoke(IPC.actionsList, limit),
    onEvent: (cb) => subscribe(IPC.actionsEvent, cb)
  }
}

contextBridge.exposeInMainWorld('arh', api)
