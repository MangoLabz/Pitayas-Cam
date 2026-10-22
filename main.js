const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');
const iphone = require('./iphone');
const android = require('./android');
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
let ffmpegMasterProc = null;
let isQuitting = false;
let wss = null;
let httpServer = null;
let localServer = null;

const virtualcam = require('./virtualcam');
const MASTER_DEV = virtualcam.DEVICE;

const cfg = core.settings.all();
// Port zablokowany przez Safari/Chromium (np. 6666) zamieniamy na bezpieczny i zapisujemy
const PORT = iphone.safePort(cfg.port);
// Drugi port (tylko 127.0.0.1) dla telefonów z Androidem podłączonych kablem przez adb reverse
const LOCAL_PORT = iphone.safePort(PORT + 1) === PORT + 1 ? PORT + 1 : PORT - 1;
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
    const servePage = (req, res) => {
        if (req.url === '/' || req.url.startsWith('/?')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(page);
        } else {
            res.writeHead(404);
            res.end();
        }
    };
    httpServer = https.createServer(tls, servePage);
    httpServer.on('error', (err) => core.log.error(`Serwer iPhone (port ${PORT}):`, err.message));

    // Android po kablu (adb reverse): telefon otwiera http://localhost:LOCAL_PORT — localhost
    // jest dla przeglądarki bezpiecznym adresem, więc kamera działa bez certyfikatu i ostrzeżeń.
    // Słuchamy tylko na 127.0.0.1, więc z sieci ten port jest niewidoczny.
    localServer = http.createServer(servePage);
    localServer.on('error', (err) => core.log.error(`Serwer lokalny (port ${LOCAL_PORT}):`, err.message));
    localServer.listen(LOCAL_PORT, '127.0.0.1');

    wss = new WebSocket.Server({ noServer: true });
    for (const srv of [httpServer, localServer]) {
        srv.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
    }

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
            virtualcam.idle.start();   // wraca plansza „aplikacja nieaktywna”
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('iphone-connected', false);
        });
    });

    httpServer.listen(PORT, '0.0.0.0');
}

async function startFfmpegPipeFromWeb() {
    stopStreaming();
    await virtualcam.idle.stop();   // zwalniamy wirtualną kamerę zajętą przez planszę
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
    ffmpegMasterProc.on('error', (err) => core.log.error('ffmpeg (obraz z telefonu):', err.message));
    ffmpegMasterProc.stdin.on('error', () => {});   // ffmpeg mógł się zakończyć — nie wywracamy aplikacji
}

function stopStreaming() {
    if (ffmpegMasterProc) {
        try {
            if (ffmpegMasterProc.stdin) ffmpegMasterProc.stdin.end();
            ffmpegMasterProc.kill();
        } catch (e) {}
        ffmpegMasterProc = null;
    }
}

// ═══════ ANDROID PRZEZ ADB ═══════
// Android 12+: scrcpy bierze obraz z aparatu prosto do wirtualnej kamery.
// Starsze: tryb przeglądarki — adb reverse + strona http://localhost na telefonie (po kablu).
let androidSession = null;   // { serial, mode: 'scrcpy' | 'browser', handle }

function sendWin(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

async function stopAndroid() {
    const s = androidSession;
    androidSession = null;
    if (!s) return;
    if (s.handle) s.handle.stop();
    if (s.mode === 'browser') await android.stopBrowser(s.serial, LOCAL_PORT);
}

ipcMain.handle('android-devices', async () => {
    const r = await android.listDevices();
    for (const d of r.devices) {
        if (d.state !== 'device') continue;
        Object.assign(d, await android.androidVersion(d.serial));
        d.mode = d.sdk >= 31 ? 'scrcpy' : 'browser';
    }
    return r;
});

ipcMain.handle('android-cameras', (event, serial) => android.listCameras(serial));

ipcMain.handle('android-start', async (event, { serial, mode, cameraId, quality }) => {
    stopStreaming();
    await stopAndroid();
    core.log.info(`Android ${serial}: start (${mode}${cameraId ? `, aparat ${cameraId}` : ''}, ${quality || '1080'}p)`);
    if (mode === 'scrcpy') {
        await virtualcam.idle.stop();
        const session = { serial, mode };
        session.handle = android.start({
            serial, cameraId, quality, sink: MASTER_DEV,
            onState: async (st) => {
                if (st.state === 'error') core.log.warn(`Android ${serial}:`, st.message);
                // Telefon odmówił aparatu przez ADB (np. starszy system) — otwieramy stronę na telefonie
                if (st.state === 'error' && androidSession === session && /Androida 12/.test(st.message || '')) {
                    const r = await android.startBrowser(serial, LOCAL_PORT);
                    if (r.ok) {
                        androidSession = { serial, mode: 'browser' };
                        sendWin('android-state', { state: 'browser', message: 'Na telefonie otworzyła się strona — dotknij „Uruchom kamerę”.' });
                        return;
                    }
                }
                if (androidSession === session && (st.state === 'error' || st.state === 'stopped')) androidSession = null;
                if (st.state === 'error' || st.state === 'stopped') virtualcam.idle.start();
                sendWin('android-state', st);
            },
        });
        androidSession = session;
        return { ok: true };
    }
    const r = await android.startBrowser(serial, LOCAL_PORT);
    if (r.ok) androidSession = { serial, mode };
    else core.log.warn(`Android ${serial}:`, r.error);
    return r;
});

ipcMain.handle('android-stop', async () => {
    await stopAndroid();
    return { ok: true };
});

ipcMain.handle('android-wifi', (event, serial) => android.enableWifi(serial));

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
    await stopAndroid();
    // Rozłączamy telefony nadające przez stronę (iPhone / Android w przeglądarce)
    if (wss) wss.clients.forEach((c) => { try { c.close(); } catch {} });
    virtualcam.idle.start();
    return { status: 'stopped' };
});

// Tylko jedna instancja — ponowne uruchomienie pokazuje okno schowane w zasobniku
core.singleInstance(() => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.whenReady().then(async () => {
    createWindow();
    createTray();
    startHttpServer();
    // Plansza „aplikacja nieaktywna” w wirtualnej kamerze, gdy nic nie nadaje
    virtualcam.idle.enabled = core.settings.get('idleScreen', true);
    if (await virtualcam.idle.install(core.paths.data, path.join(__dirname, 'assets', 'idle.png'))) {
        if (virtualcam.idle.enabled) virtualcam.idle.start(); else virtualcam.idle.disable();
    }
    const vs = virtualcam.status();
    if (vs.needsFix) core.log.warn(`Wirtualna kamera: ${vs.exists ? `nazwa „${vs.name}”` : 'brak urządzenia'}${vs.others.length ? `, dodatkowe: ${vs.others.map((o) => o.name).join(', ')}` : ''}`);
});

// ───── Wirtualna kamera: nazwa w systemie i plansza ─────
ipcMain.handle('vcam-status', async () => ({
    ...virtualcam.status(),
    idleEnabled: virtualcam.idle.enabled,
    idleActive: await virtualcam.idle.isActive(),
}));
ipcMain.handle('vcam-fix', async () => {
    const r = await virtualcam.fix();
    core.log.info('Naprawa wirtualnej kamery:', JSON.stringify(r));
    return r;
});
ipcMain.handle('vcam-idle', async (event, enabled) => {
    core.settings.set('idleScreen', Boolean(enabled));
    virtualcam.idle.enabled = Boolean(enabled);
    if (enabled) {
        const busy = Boolean(ffmpegMasterProc || androidSession);
        await virtualcam.idle.install(core.paths.data, path.join(__dirname, 'assets', 'idle.png'));
        if (!busy) await virtualcam.idle.start();
    } else {
        await virtualcam.idle.disable();
    }
    return { ok: true };
});

// Przy wyjściu zatrzymujemy scrcpy, zdejmujemy adb reverse i oddajemy kamerę planszy
app.on('before-quit', () => {
    stopAndroid();
    if (virtualcam.idle.enabled) {
        try { require('child_process').execFileSync('systemctl', ['--user', 'start', 'pitaya-cam-idle.service'], { timeout: 5000 }); } catch {}
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
