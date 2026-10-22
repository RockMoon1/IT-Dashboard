import { registerHooks } from 'node:module'

/*
  Electron as src/main/ipc.ts sees it, for loading the main process under node (Electron is not
  installed for these tests): ipcMain.handle keeps each handler, so a test calls a channel the
  way the renderer's invoke does and runs the main process's own code for it. Nothing here opens
  a window, a keystore or the network.
*/

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

const electron = {
  app: {
    getVersion: (): string => '0.0.0-test',
    getPath: (): string => '',
    getAppPath: (): string => '',
    isPackaged: false
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
  },
  ipcMain: {
    handle: (channel: string, handler: Handler): void => {
      handlers.set(channel, handler)
    }
  },
  shell: {
    openExternal: async (): Promise<void> => {
      throw new Error('tests open nothing')
    },
    openPath: async (): Promise<string> => 'tests open nothing'
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    encryptString: (): Buffer => {
      throw new Error('no keystore in tests')
    },
    decryptString: (): string => {
      throw new Error('no keystore in tests')
    }
  },
  dialog: { showErrorBox: (): void => {} }
}
Object.assign(globalThis, { electronStandIn: electron })
const source = `export const { ${Object.keys(electron).join(', ')} } = globalThis.electronStandIn`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron')
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

export interface MainPaths {
  settingsFile: string
  appDataDir: string
  profilesDir: string
  actionsDir: string
  agentBinary: string | null
  agentDistDir: string | null
}

/**
 * The main process's AppContext with its IPC handlers registered (not started: no link, no
 * detection), and a call to one of its channels as the renderer makes it.
 */
export async function mainProcess(
  paths: MainPaths
): Promise<<T>(channel: string, ...args: unknown[]) => Promise<T>> {
  const { AppContext } = (await import(new URL('../../src/main/ipc.ts', import.meta.url).href)) as {
    AppContext: { create(paths: MainPaths): Promise<{ registerIpc(): void }> }
  }
  handlers.clear()
  const ctx = await AppContext.create(paths)
  ctx.registerIpc()
  return async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return (await handler({}, ...args)) as T
  }
}
