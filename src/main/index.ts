import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { AppContext } from './ipc.ts'

let ctx: AppContext | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
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

void app.whenReady().then(async () => {
  ctx = await AppContext.create(join(app.getPath('userData'), 'settings.json'))
  ctx.registerIpc()
  ctx.attachWindow(createWindow())
  ctx.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && ctx) ctx.attachWindow(createWindow())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ctx?.stop()
})
