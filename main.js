process.on('uncaughtException', (err) => {
    console.error('Przechwycony błąd:', err.message);
});

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');
const { createUpdater } = require('./updater');

const updater = createUpdater({ repo: 'MangoLabz/Pitayas-Cam', branch: 'main', appDir: __dirname });

// Ustawienia: jeśli jest folder z czasów Mango (~/.config/mangocam), używamy go dalej
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'mangocam');
if (fs.existsSync(LEGACY_USER_DATA)) app.setPath('userData', LEGACY_USER_DATA);
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

const LEGACY_CONFIG = path.join(app.getPath('userData'), 'mangocam-config.json');
const configPath = fs.existsSync(LEGACY_CONFIG)
    ? LEGACY_CONFIG
    : path.join(app.getPath('userData'), 'pitayacam-config.json');
let PORT = 2137;
let widgetPos = 'none';
let widgetUrl = '';
let widgetStyle = 'boxy';
let widgetScale = 100;

try {
    if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath));
        if (cfg.port) PORT = cfg.port;
        if (cfg.widgetPos) widgetPos = cfg.widgetPos;
        if (cfg.widgetUrl !== undefined) widgetUrl = cfg.widgetUrl;
        if (cfg.widgetStyle) widgetStyle = cfg.widgetStyle;
        if (cfg.widgetScale) widgetScale = cfg.widgetScale;
    }
} catch(e) {}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.includes('docker') || name.includes('veth') || name.includes('virbr') || name.includes('tailscale') || name.includes('tun')) continue;
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function startHttpServer() {
    const htmlClient = `<!DOCTYPE html>
    <html lang="pl">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pitaya Cam Streamer</title>
    <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: #0c0c0e; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #18181b; border: 1px solid rgba(255,255,255,0.08); padding: 24px; border-radius: 20px; width: 100%; max-width: 420px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h2 { background: linear-gradient(135deg, #ff9bd0, #e6007e); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 6px; font-size: 24px; font-weight: 800; }
    p.sub { color: #a1a1aa; font-size: 13px; margin-bottom: 20px; }
    .preview-box { width: 100%; height: 380px; background: #000; border-radius: 14px; overflow: hidden; position: relative; border: 1px solid #27272a; margin-bottom: 18px; }
    video { width: 100%; height: 100%; object-fit: contain; }
    button { background: linear-gradient(135deg, #ff4fa6, #a3005a); color: white; border: none; padding: 14px; width: 100%; font-size: 15px; font-weight: 700; border-radius: 12px; cursor: pointer; transition: opacity 0.2s; box-shadow: 0 4px 14px rgba(230,57,0,0.35); }
    button:active { opacity: 0.85; }
    #status { margin-top: 14px; font-size: 13px; font-weight: 600; color: #ff4fa6; }
    </style>
    </head>
    <body>
    <div class="card">
    <h2>🐉 Pitaya Cam</h2>
    <p class="sub">Transmisja kamery z telefonu</p>
    <div class="preview-box">
    <video id="v" autoplay playsinline muted></video>
    </div>
    <button id="btn">Uruchom kamerę</button>
    <div id="status">Gotowy do połączenia</div>
    </div>
    <canvas id="c" style="display:none;"></canvas>

    <script>
    const v = document.getElementById('v');
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const btn = document.getElementById('btn');
    const st = document.getElementById('status');
    let ws = null;
    let timer = null;

    btn.onclick = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false
            });
            v.srcObject = stream;
            btn.style.display = 'none';
            st.textContent = 'Łączenie z aplikacją...';

            ws = new WebSocket('ws://' + location.host);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                st.textContent = '🟢 Przesyłanie aktywne';
                v.onloadedmetadata = () => {
                    c.width = v.videoWidth;
                    c.height = v.videoHeight;
                };
                timer = setInterval(() => {
                    if (v.readyState >= 2 && ws.readyState === WebSocket.OPEN) {
                        if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
                            c.width = v.videoWidth;
                            c.height = v.videoHeight;
                        }
                        ctx.drawImage(v, 0, 0, c.width, c.height);
                        c.toBlob(blob => {
                            if (blob && ws.readyState === WebSocket.OPEN) {
                                blob.arrayBuffer().then(buf => ws.send(buf));
                            }
                        }, 'image/jpeg', 0.85);
                    }
                }, 33);
            };

            ws.onclose = () => {
                st.textContent = '🔴 Rozłączono';
                clearInterval(timer);
            };
        } catch (err) {
            st.textContent = 'Błąd: ' + err.message;
        }
    };
    </script>
    </body>
    </html>`;

    httpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlClient);
    });

    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws) => {
        if (mainWindow) mainWindow.webContents.send('iphone-connected', true);
        startFfmpegPipeFromWeb();

        ws.on('message', (data) => {
            if (ffmpegMasterProc && ffmpegMasterProc.stdin && !ffmpegMasterProc.stdin.destroyed) {
                try { ffmpegMasterProc.stdin.write(Buffer.from(data)); } catch (e) {}
            }
            if (mainWindow) mainWindow.webContents.send('iphone-frame', Buffer.from(data));
        });

            ws.on('close', () => {
                stopStreaming();
                if (mainWindow) mainWindow.webContents.send('iphone-connected', false);
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

ipcMain.handle('get-config', () => {
    return {
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
        fs.writeFileSync(configPath, JSON.stringify({
            port: parseInt(newConfig.port),
                                                    widgetPos: newConfig.widgetPos,
                                                    widgetUrl: newConfig.widgetUrl,
                                                    widgetStyle: newConfig.widgetStyle,
                                                    widgetScale: parseInt(newConfig.widgetScale)
        }));
    } catch(e) {}
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

ipcMain.on('win-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win-close', () => { if (mainWindow) mainWindow.hide(); });

// ═══════ AKTUALIZACJE GITHUB ═══════
ipcMain.handle('app-info', () => ({ name: 'Pitaya Cam', version: app.getVersion(), repoUrl: updater.repoUrl }));
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-apply', () => updater.apply());
ipcMain.on('update-restart', () => {
    isQuitting = true;
    stopStreaming();
    if (httpServer) httpServer.close();
    updater.restart();
});
ipcMain.handle('open-external', (event, url) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url);
});
ipcMain.handle('stop-stream', async () => {
    stopStreaming();
    return { status: 'stopped' };
});

// Tylko jedna instancja — ponowne uruchomienie pokazuje okno schowane w zasobniku
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    startHttpServer();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
