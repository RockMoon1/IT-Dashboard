import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppContext, locateAgentBinary } from './ipc.ts'

let ctx: AppContext | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#060908',
    title: 'ARH IT Dashboard',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function profilesDir(): string {
  const packaged = join(process.resourcesPath, 'profiles')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'profiles')
}

void app.whenReady().then(async () => {
  const appDataDir = app.getPath('userData')
  const agent = locateAgentBinary(app.getAppPath(), process.resourcesPath, app.isPackaged)
  ctx = await AppContext.create({
    settingsFile: join(appDataDir, 'settings.json'),
    appDataDir,
    profilesDir: profilesDir(),
    agentBinary: agent.binary,
    agentDistDir: agent.distDir
  })
  ctx.registerIpc()
  ctx.attachWindow(createWindow())
  await ctx.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && ctx) ctx.attachWindow(createWindow())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void ctx?.stop()
})
