const { app, BrowserWindow, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { print } = require('pdf-to-printer');

const APP_NAME = 'DTF Gangsheet Printer Bridge';
const DEFAULT_PORT = 3321;
const HOST = process.env.PRINTER_BRIDGE_HOST || '127.0.0.1';

let tray = null;
let hiddenWindow = null;
let printers = [];
let httpServer = null;
let settingsPath = '';
let isShuttingDown = false;
let settings = {
  selectedPrinter: null,
  serverPort: Number.parseInt(process.env.PRINTER_BRIDGE_PORT || '', 10) || DEFAULT_PORT,
};

const appState = {
  serverStatus: 'Starting',
  serverPort: settings.serverPort,
};

const fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

const ensureSingleInstance = () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    notify('DTF Gangsheet Printer Bridge is already running in the tray.');
  });
  return true;
};

const createHiddenWindow = () =>
  new Promise((resolve) => {
    hiddenWindow = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        sandbox: false,
      },
    });
    hiddenWindow.webContents.once('did-finish-load', () => resolve());
    hiddenWindow.loadURL('about:blank');
    hiddenWindow.on('close', (event) => {
      if (!app.isQuitting) {
        event.preventDefault();
        hiddenWindow?.hide();
      }
    });
  });

const createTrayIcon = () => {
  
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  return nativeImage.createFromPath(iconPath).resize({
    width: 32,
    height: 32,
  });
};

const createTray = () => {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    tray?.popUpContextMenu();
  });
  updateTrayMenu();
};

const notify = (body) => {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title: APP_NAME, body }).show();
};

const loadSettings = () => {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) {
      const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings = { ...settings, ...stored };
      appState.serverPort = settings.serverPort || DEFAULT_PORT;
    }
  } catch (error) {
    console.error('Failed to read settings:', error);
  }
};

const persistSettings = () => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write settings:', error);
  }
};

const getPrinterDisplayName = (printerName) => {
  if (!printerName) {
    return 'Not selected';
  }
  const printer =
    printers.find((entry) => entry.name === printerName || entry.displayName === printerName) || null;
  if (!printer) {
    return printerName;
  }
  return printer.displayName || printer.name;
};

const updateTrayMenu = () => {
  if (!tray) {
    return;
  }
  const printerItems = printers.length
    ? printers.map((printer) => ({
        label: printer.displayName || printer.name,
        type: 'radio',
        checked: settings.selectedPrinter === printer.name,
        click: () => setSelectedPrinter(printer.name, true),
      }))
    : [{ label: 'No printers detected', enabled: false }];

  const template = [
    { label: `Printer: ${getPrinterDisplayName(settings.selectedPrinter)}`, enabled: false },
    { label: 'Choose Printer', submenu: printerItems },
    { label: 'Refresh Printers', click: () => refreshPrinters() },
    { type: 'separator' },
    { label: `Server: ${appState.serverStatus}`, enabled: false },
    { label: `Port: ${appState.serverPort}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => attemptQuit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
};

const setSelectedPrinter = (printerName, persist = true, silent = false) => {
  if (!printerName || settings.selectedPrinter === printerName) {
    return;
  }
  settings.selectedPrinter = printerName;
  if (persist) {
    persistSettings();
  }
  updateTrayMenu();
  if (!silent) {
    notify(`Selected printer: ${getPrinterDisplayName(printerName)}`);
  }
};

const refreshPrinters = async () => {
  if (!hiddenWindow) {
    return printers;
  }
  try {
    printers = await hiddenWindow.webContents.getPrintersAsync();
    if (!settings.selectedPrinter && printers.length) {
      const preferred = printers.find((printer) => printer.isDefault) || printers[0];
      setSelectedPrinter(preferred.name, true, true);
    }
  } catch (error) {
    console.error('Failed to fetch printers', error);
  }
  updateTrayMenu();
  notify("Refreshed printers")
  return printers;
};

const downloadPdf = async (fileUrl) => {
  if (!fetchImpl) {
    throw new Error('Fetch API is not available in this version of Electron.');
  }
  const response = await fetchImpl(fileUrl);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error('Downloaded file is empty.');
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'printer-ws-'));
  const filePath = path.join(tempDir, 'document.pdf');
  await fs.promises.writeFile(filePath, buffer);
  return {
    filePath,
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
};

const ensurePrinterAvailable = async (targetPrinter) => {
  const printerExists = printers.some((printer) => printer.name === targetPrinter);
  if (printerExists) {
    return true;
  }
  await refreshPrinters();
  return printers.some((printer) => printer.name === targetPrinter);
};

const createServer = () => {
  const serverApp = express();
  serverApp.use(cors());
  serverApp.use(bodyParser.json({ limit: '2mb' }));

  serverApp.get('/status', (req, res) => {
    res.json({
      ok: true,
      server: { host: HOST, port: appState.serverPort, status: appState.serverStatus },
      selectedPrinter: settings.selectedPrinter,
      printers: printers.map((printer) => ({
        name: printer.name,
        displayName: printer.displayName,
        description: printer.description,
        status: printer.status,
        isDefault: printer.isDefault,
      })),
    });
    notify("DTF Gangsheet Printer Bridge started.")
  });

  serverApp.post('/printers/select', async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ ok: false, error: 'Printer "name" is required.' });
      return;
    }
    const exists = printers.find((printer) => printer.name === name.trim());
    if (!exists) {
      await refreshPrinters();
    }
    const finalPrinter = printers.find((printer) => printer.name === name.trim());
    if (!finalPrinter) {
      res.status(404).json({ ok: false, error: 'Printer not found.' });
      return;
    }
    setSelectedPrinter(finalPrinter.name, true);
    res.json({ ok: true, selectedPrinter: finalPrinter.name });
  });

  serverApp.post('/printers/refresh', async (req, res) => {
    await refreshPrinters();
    res.json({
      ok: true,
      printers: printers.map((printer) => ({
        name: printer.name,
        displayName: printer.displayName,
        description: printer.description,
        status: printer.status,
        isDefault: printer.isDefault,
      })),
    });
  });

  serverApp.post('/print', async (req, res) => {
    const { url, printerName, copies } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ ok: false, error: 'Field "url" is required.' });
      return;
    }

    const normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      res.status(400).json({ ok: false, error: 'Only http/https URLs are supported.' });
      return;
    }
    const targetPrinter = (printerName || settings.selectedPrinter || '').trim();
    if (!targetPrinter) {
      res.status(400).json({ ok: false, error: 'No printer selected.' });
      return;
    }
    const printerReady = await ensurePrinterAvailable(targetPrinter);
    if (!printerReady) {
      res.status(404).json({ ok: false, error: 'Selected printer is not available.' });
      return;
    }
    const printOptions = { printer: targetPrinter };
    const copiesValue = Number.parseInt(copies, 10);
    if (Number.isFinite(copiesValue) && copiesValue > 0) {
      printOptions.copies = copiesValue;
    }
    try {
      const task = await downloadPdf(normalizedUrl);
      try {
        await print(task.filePath, printOptions);
        res.json({ ok: true, printer: targetPrinter });
        notify(`Sent document to ${getPrinterDisplayName(targetPrinter)}`);
      } finally {
        await task.cleanup();
      }
    } catch (error) {
      console.error('Print job failed', error);
      res.status(500).json({ ok: false, error: error.message });
      notify(`Print failed: ${error.message}`);
    }
  });

  return serverApp;
};

const startServer = () =>
  new Promise((resolve, reject) => {
    if (httpServer) {
      resolve();
      return;
    }
    const serverApp = createServer();
    httpServer = serverApp.listen(appState.serverPort, HOST, () => {
      appState.serverStatus = 'Listening';
      updateTrayMenu();
      resolve();
    });
    httpServer.on('error', (error) => {
      console.error('Server error:', error);
      appState.serverStatus = 'Error';
      updateTrayMenu();
      reject(error);
    });
  });

const shutdown = async () => {
  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
    httpServer = null;
  }
  tray?.destroy();
  hiddenWindow?.destroy();
};

const attemptQuit = async () => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  await shutdown();
  app.isQuitting = true;
  app.exit(0);
};

const bootstrap = async () => {
  if (!ensureSingleInstance()) {
    return;
  }
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  settingsPath = path.join(app.getPath('userData'), 'printer-bridge-settings.json');
  loadSettings();
  await createHiddenWindow();
  createTray();
  await refreshPrinters();
  try {
    await startServer();
  } catch (error) {
    notify('Unable to start local server. See logs.');
  }
};

app.whenReady().then(bootstrap);

app.on('before-quit', (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    attemptQuit();
  } else {
    app.isQuitting = true;
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
