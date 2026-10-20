const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');
const iphone = require('./iphone');
// Pitaya Core: dane w ~/.config/Pitayas/Cam, ustawienia, logi, aktualizacje.
// Ustawienia z czasów Mango (~/.config/mangocam) i pierwszych wersji Pitaya przenosimy przy pierwszym starcie.
const core = require('./core').create({
    id: 'cam',
    folder: 'Cam',
    name: 'Pitaya Cam',
    repo: 'MangoLabz/Pitayas-Cam',
    appDir: __dirname,
    defaults: { port: 2137, widgetPos: 'none', widgetUrl: '', widgetStyle: 'boxy', widgetScale: 100 },
    legacy: [
        { from: 'mangocam/mangocam-config.json', to: 'settings.json' },
        { from: 'mangocam/pitayacam-config.json', to: 'settings.json' },
        { from: 'pitayacam/pitayacam-config.json', to: 'settings.json' },
    ],
});
const ICON_PATH = path.join(__dirname, 'build', 'icons', '512x512.png');
const TRAY_ICON_PATH = path.join(__dirname, 'build', 'icons', '32x32.png');

let mainWindow = null;
let tray = null;
let scrcpyProc = null;
let ffmpegMasterProc = null;
let isQuitting = false;
let wss = null;
let httpServer = null;

const MASTER_DEV = "/dev/video10";
const FEED_DEV = "/dev/video12";

const cfg = core.settings.all();
// Port zablokowany przez Safari/Chromium (np. 6666) zamieniamy na bezpieczny i zapisujemy
const PORT = iphone.safePort(cfg.port);
if (PORT !== parseInt(cfg.port, 10)) {
    core.settings.set('port', PORT);
    core.log.warn(`Port ${cfg.port} jest blokowany przez przeglądarki — zmieniono na ${PORT}`);
}
const widgetPos = cfg.widgetPos || 'none';
const widgetUrl = cfg.widgetUrl || '';
const widgetStyle = cfg.widgetStyle || 'boxy';
const widgetScale = parseInt(cfg.widgetScale, 10) || 100;

function getLocalIp() {
    const first = iphone.listAddresses()[0];
    return first ? first.ip : '127.0.0.1';
}

// Serwer dla iPhone'a: HTTPS (Safari daje kamerę tylko bezpiecznym stronom) + WebSocket z klatkami
function startHttpServer() {
    const page = fs.readFileSync(path.join(__dirname, 'iphone-client.html'));
    let tls;
    try {
        tls = iphone.ensureCert(core.paths.data, (...a) => core.log.info(...a));
    } catch (err) {
        core.log.error('Nie udało się utworzyć certyfikatu HTTPS:', err);
        return;
    }
    httpServer = https.createServer(tls, (req, res) => {
        if (req.url === '/' || req.url.startsWith('/?')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(page);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    httpServer.on('error', (err) => core.log.error(`Serwer iPhone (port ${PORT}):`, err.message));

    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iphone-connected', true);
        startFfmpegPipeFromWeb();

        ws.on('message', (data) => {
            if (ffmpegMasterProc && ffmpegMasterProc.stdin && !ffmpegMasterProc.stdin.destroyed) {
                try { ffmpegMasterProc.stdin.write(Buffer.from(data)); } catch (e) {}
            }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iphone-frame', Buffer.from(data));
        });

            ws.on('close', () => {
                stopStreaming();
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iphone-connected', false);
            });
    });

    httpServer.listen(PORT, '0.0.0.0');
}

function startFfmpegPipeFromWeb() {
    stopStreaming();
    const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', '30',
        '-i', '-',
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0c0c0e,format=yuv420p',
        '-f', 'v4l2',
        '-pix_fmt', 'yuv420p',
        MASTER_DEV
    ];
    ffmpegMasterProc = spawn('ffmpeg', ffmpegArgs);
    ffmpegMasterProc.on('error', () => {});
}

function stopStreaming() {
    if (ffmpegMasterProc) {
        try {
            if (ffmpegMasterProc.stdin) ffmpegMasterProc.stdin.end();
            ffmpegMasterProc.kill();
        } catch (e) {}
        ffmpegMasterProc = null;
    }
    if (scrcpyProc) {
        try { scrcpyProc.kill(); } catch (e) {}
        scrcpyProc = null;
    }
}

ipcMain.handle('get-adb-devices', async () => {
    return new Promise((resolve) => {
        exec('adb devices -l', (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const lines = stdout.trim().split('\n').slice(1);
            const devices = [];
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2 && parts[1] === 'device') {
                    const serial = parts[0];
                    let model = 'Android';
                    for (const p of parts) {
                        if (p.startsWith('model:')) model = p.split(':')[1].replace(/_/g, ' ');
                    }
                    devices.push({
                        serial: serial,
                        label: `🤖 ${model} (${serial})`
                    });
                }
            }
            resolve(devices);
        });
    });
});

ipcMain.handle('start-android-stream', async (event, config) => {
    stopStreaming();
    const { serial, resolution, facing } = config;
    const res = resolution || "1920x1080";
    const camFacing = facing === 'rear' ? 'back' : 'front';

    exec(`adb -s ${serial} shell input keyevent KEYCODE_WAKEUP`);

    const scrcpyArgs = [
        '--serial', serial,
        '--video-source=camera',
        '--video-codec=h264',
        '--stay-awake',
        `--camera-size=${res}`,
        '--camera-fps=30',
        '--video-bit-rate=8M',
        `--camera-facing=${camFacing}`,
        '--no-playback',
        '--no-audio',
        `--v4l2-sink=${FEED_DEV}`
    ];

    try {
        scrcpyProc = spawn('scrcpy', scrcpyArgs, {
            env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }
        });

        scrcpyProc.on('error', (err) => {
            stopStreaming();
            dialog.showErrorBox('Brak scrcpy', 'Nie odnaleziono programu scrcpy w systemie.');
        });

        setTimeout(() => {
            if (!scrcpyProc) return;
            const ffmpegArgs = [
                '-hide_banner', '-loglevel', 'error', '-nostdin',
                '-thread_queue_size', '512',
                '-f', 'v4l2', '-i', FEED_DEV,
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0c0c0e,format=yuv420p',
                   '-r', '30',
                   '-f', 'v4l2',
                   '-pix_fmt', 'yuv420p',
                   MASTER_DEV
            ];
            ffmpegMasterProc = spawn('ffmpeg', ffmpegArgs);
            ffmpegMasterProc.on('error', () => {});
        }, 3000);

        return { status: 'running' };
    } catch (err) {
        stopStreaming();
        dialog.showErrorBox('Błąd uruchomienia', err.message);
        return { status: 'error' };
    }
});

// Automatyczne sprawdzanie typu/motywu widżetu z 6klabs
ipcMain.handle('detect-widget-style', async (event, url) => {
    if (!url || !url.startsWith('http')) return 'boxy';
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                const lower = data.toLowerCase();
                if (lower.includes('"gallery"') || lower.includes('gallery')) resolve('gallery');
                else if (lower.includes('"minimal"') || lower.includes('minimal')) resolve('minimal');
                else if (lower.includes('"compact"') || lower.includes('compact')) resolve('compact');
                else if (lower.includes('"macos"') || lower.includes('macos')) resolve('macos');
                else if (lower.includes('"shell"') || lower.includes('shell')) resolve('shell');
                else if (lower.includes('"discord"') || lower.includes('discord')) resolve('discord');
                else if (lower.includes('"boxy"') || lower.includes('boxy')) resolve('boxy');
                else resolve('boxy');
            });
        }).on('error', () => resolve('boxy'));
    });
});

// Stan iPhone'a dla okna: adresy (kabel / Wi‑Fi) i czy telefon jest podłączony kablem
ipcMain.handle('iphone-status', () => ({
    port: PORT,
    server: Boolean(httpServer && httpServer.listening),
    addresses: iphone.listAddresses(),
    usb: iphone.usbStatus(),
}));

ipcMain.handle('get-config', () => {
    return {
        blockedPorts: iphone.BLOCKED_PORTS,
        port: PORT,
        ip: getLocalIp(),
               widgetPos: widgetPos,
               widgetUrl: widgetUrl,
               widgetStyle: widgetStyle,
               widgetScale: widgetScale
    };
});

ipcMain.handle('save-config', (event, newConfig) => {
    try {
        core.settings.set({
            port: iphone.safePort(newConfig.port),
            widgetPos: newConfig.widgetPos,
            widgetUrl: newConfig.widgetUrl,
            widgetStyle: newConfig.widgetStyle,
            widgetScale: parseInt(newConfig.widgetScale, 10) || 100,
        });
    } catch (e) {
        core.log.error('Nie udało się zapisać ustawień:', e);
    }
    isQuitting = true;
    stopStreaming();
    app.relaunch();
    app.exit();
});

function createWindow() {
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
        width: 500,
        height: 780,
        minWidth: 440,
        minHeight: 560,
        frame: false,
        title: 'Pitaya Cam',
        backgroundColor: '#121116',
        icon: ICON_PATH,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    const icon = nativeImage.createFromPath(TRAY_ICON_PATH).resize({ width: 22, height: 22 });
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Pokaż / Ukryj okno', click: () => { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } },
                                               { type: 'separator' },
                                               { label: 'Zakończ Pitaya Cam', click: () => {
                                                   isQuitting = true;
                                                   stopStreaming();
                                                   if (httpServer) httpServer.close();
                                                   app.quit();
                                               }
                                               }
    ]);

    tray.setToolTip('Pitaya Cam');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });
}

ipcMain.on('pitaya:win-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('pitaya:win-close', () => { if (mainWindow) mainWindow.hide(); });

// Wspólne kanały Pitaya Core: informacje, ustawienia, folder danych, aktualizacje
core.registerIpc({
    beforeRestart: () => {
        isQuitting = true;
        stopStreaming();
        if (httpServer) httpServer.close();
    },
});
ipcMain.handle('stop-stream', async () => {
    stopStreaming();
    return { status: 'stopped' };
});

// Tylko jedna instancja — ponowne uruchomienie pokazuje okno schowane w zasobniku
core.singleInstance(() => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.whenReady().then(() => {
    createWindow();
    createTray();
    startHttpServer();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
