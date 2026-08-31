'use strict';
/* ============================================================
   Electron main — เปิดเซิร์ฟเวอร์ในตัวแล้วแสดงเป็นหน้าต่างโปรแกรม
   ไม่มี command prompt / console ให้ผู้ใช้เห็น
   ============================================================ */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT) || 3007;
process.env.PORT = String(PORT);

// เก็บไฟล์ตั้งค่า (การเชื่อมต่อ/ตาราง/ประวัติ) ไว้ในโฟลเดอร์ข้อมูลผู้ใช้ (เขียนได้)
process.env.TOOLHOSO4_CONFIG_DIR = path.join(app.getPath('userData'), 'config');

// อนุญาตให้เปิดโปรแกรมได้ครั้งเดียว (กันเปิดซ้ำแล้วชนพอร์ต)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let serverInstance = null;
let mainWindow = null;

function startServer() {
  try {
    const server = require(path.join(__dirname, '..', 'server.js'));
    serverInstance = server.start(PORT);
    serverInstance.on('error', (err) => {
      dialog.showErrorBox('HOSOS to HOSxP',
        'ไม่สามารถเริ่มระบบภายในได้ (พอร์ต ' + PORT + ')\n' +
        (err && err.code === 'EADDRINUSE'
          ? 'พอร์ต ' + PORT + ' ถูกใช้งานอยู่ อาจมีโปรแกรมเปิดค้างอยู่'
          : (err && err.message) || String(err)));
    });
  } catch (e) {
    dialog.showErrorBox('HOSOS to HOSxP', 'เริ่มระบบภายในล้มเหลว:\n' + ((e && e.message) || String(e)));
  }
}

function waitForServer(cb, tries) {
  tries = tries || 0;
  const req = http.get('http://127.0.0.1:' + PORT + '/api/health', (res) => {
    res.resume();
    cb();
  });
  req.on('error', () => {
    if (tries > 150) return cb(); // ~15 วินาที แล้วเปิดหน้าต่างไปเลย
    setTimeout(() => waitForServer(cb, tries + 1), 100);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'HOSOS to HOSxP',
    backgroundColor: '#fff7fa',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL('http://127.0.0.1:' + PORT + '/');

  // ลิงก์ที่เปิดหน้าต่างใหม่ → เปิดในเบราว์เซอร์ระบบแทน
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && url.indexOf('127.0.0.1:' + PORT) === -1) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(() => {
  startServer();
  waitForServer(() => createWindow());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('quit', () => { try { serverInstance && serverInstance.close(); } catch (e) {} });
