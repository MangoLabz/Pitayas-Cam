// ═══════ PITAYA CORE ═══════
// Wspólny rdzeń aplikacji Pitayas (proces główny Electrona).
//
// Wszystkie aplikacje trzymają dane w jednym folderze, każda w swoim podfolderze:
//
//   ~/.config/Pitayas/              (Windows: %APPDATA%\Pitayas, macOS: ~/Library/Application Support/Pitayas)
//     apps/<id>.json                wpis aplikacji: nazwa, wersja, jak ją uruchomić, ikona (registry.js)
//     run/<id>.json, run/<id>.sock  gdy działa: pid, status i gniazdo sterowania (control.js)
//     core.json                     stary zbiorczy spis aplikacji (dla zgodności)
//     Bot-Builder/  Cam/  Convert/  Deck/  Book/
//       settings.json               ustawienia aplikacji
//       data/                       dane aplikacji (projekty, historia…)
//       logs/app.log                dziennik (z rotacją)
//       cache/                      pamięć podręczna Electrona/Chromium
//       icon.png                    ikona aplikacji (dla huba)
//
// Użycie (na samej górze main.js, przed app.whenReady):
//   const core = require('./core').create({ id: 'convert', folder: 'Convert', name: 'Pitaya Convert',
//                                           repo: 'MangoLabz/Pitayas-Convert', appDir: __dirname,
//                                           legacy: [{ from: 'mango-convert/settings.json', to: 'settings.json' }] });
const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createUpdater, compareVersions } = require('./updater');
const registry = require('./registry');
const control = require('./control');

const CORE_VERSION = '0.2.1';

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Zapis przez plik tymczasowy, żeby przerwany zapis nie zostawił uszkodzonego JSON-a
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

function createLogger(logsDir, name) {
    const file = path.join(logsDir, 'app.log');
    const MAX = 1024 * 1024;
    function write(level, args) {
        const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        const line = `${new Date().toISOString()} [${level}] ${text}\n`;
        try {
            fs.mkdirSync(logsDir, { recursive: true });
            if (fs.existsSync(file) && fs.statSync(file).size > MAX) fs.renameSync(file, `${file}.1`);
            fs.appendFileSync(file, line);
        } catch {}
        (level === 'ERROR' ? console.error : console.log)(`[${name}] ${text}`);
    }
    return {
        file,
        info: (...a) => write('INFO', a),
        warn: (...a) => write('WARN', a),
        error: (...a) => write('ERROR', a),
    };
}

function create(options) {
    const { id, folder, name, repo, appDir, branch = 'main', legacy = [], defaults = {}, icon } = options;
    if (!id || !folder || !name || !appDir) throw new Error('Pitaya Core: wymagane są id, folder, name i appDir');

    const appData = app.getPath('appData');
    const root = path.join(appData, 'Pitayas');
    const dir = path.join(root, folder);
    const paths = {
        root,
        dir,
        data: path.join(dir, 'data'),
        logs: path.join(dir, 'logs'),
        cache: path.join(dir, 'cache'),
        settings: path.join(dir, 'settings.json'),
        coreFile: path.join(root, 'core.json'),
    };
    const firstRun = !fs.existsSync(dir);
    for (const p of [paths.data, paths.logs, paths.cache]) fs.mkdirSync(p, { recursive: true });

    // Nazwa w systemie i miejsce danych — musi się wydarzyć przed app.whenReady
    app.setName(name);
    app.setPath('userData', dir);
    try { app.setPath('sessionData', paths.cache); } catch {}
    try { app.setPath('crashDumps', path.join(paths.cache, 'crashpad')); } catch {}

    const log = createLogger(paths.logs, name);
    process.on('uncaughtException', (err) => log.error('Nieobsłużony błąd:', err));
    process.on('unhandledRejection', (err) => log.error('Nieobsłużona obietnica:', err));

    // Migracja ze starych folderów (Mango…, pierwsze wersje Pitaya). Kopiujemy tylko to,
    // czego jeszcze nie ma w nowym miejscu — stare foldery zostają nietknięte.
    const migrated = [];
    for (const item of legacy) {
        const from = path.isAbsolute(item.from) ? item.from : path.join(appData, item.from);
        const to = path.join(dir, item.to);
        if (!fs.existsSync(from) || fs.existsSync(to)) continue;
        try {
            if (item.transform) writeJson(to, item.transform(readJson(from, {})));
            else copyRecursive(from, to);
            migrated.push(`${from} → ${to}`);
        } catch (err) {
            log.warn('Nie udało się przenieść', from, err.message);
        }
    }
    if (migrated.length) log.info('Przeniesiono stare dane:', migrated);

    // Ustawienia aplikacji
    let cache = { ...defaults, ...readJson(paths.settings, {}) };
    const settings = {
        all: () => ({ ...cache }),
        get: (key, fallback) => (key in cache ? cache[key] : fallback),
        set(key, value) {
            if (typeof key === 'object') cache = { ...cache, ...key };
            else cache[key] = value;
            writeJson(paths.settings, cache);
            return { ...cache };
        },
    };

    // Ikona do rejestru (z asar nikt poza aplikacją jej nie odczyta, więc kopiujemy ją do folderu danych)
    function copyIcon() {
        const candidates = [icon, 'build/icons/256x256.png', 'build/icons/512x512.png', 'build/icon.png', 'assets/icon.png', 'icon.png']
            .filter(Boolean).map((p) => (path.isAbsolute(p) ? p : path.join(appDir, p)));
        const src = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
        if (!src) return null;
        const dest = path.join(dir, 'icon.png');
        try { fs.writeFileSync(dest, fs.readFileSync(src)); return dest; } catch { return null; }
    }
    // Jak uruchomić tę aplikację z zewnątrz (hub, inna aplikacja)
    function launchSpec() {
        if (process.env.APPIMAGE) return { command: process.env.APPIMAGE, args: [] };
        if (app.isPackaged) return { command: process.execPath, args: [] };
        return { command: process.execPath, args: [appDir], cwd: appDir };
    }
    const pkg = readJson(path.join(appDir, 'package.json'), {});

    // Wspólny rejestr: które aplikacje Pitayas są na tym komputerze
    function register() {
        try {
            registry.register({
                id, name, folder, kind: 'electron',
                description: options.description || pkg.description || '',
                version: app.getVersion(), coreVersion: CORE_VERSION,
                executable: process.env.APPIMAGE || process.execPath, packaged: app.isPackaged,
                launch: launchSpec(), icon: copyIcon(), repo: repo || null,
                dataDir: dir, platform: process.platform,
            }, root);
        } catch (err) { log.warn('Nie udało się zapisać rejestru aplikacji', err.message); }
    }

    // Kanał sterowania: hub i inne aplikacje mogą zapytać o stan, pokazać okno albo zamknąć aplikację
    const handlers = new Map();
    let onShow = null;
    let secondary = false;   // drugie uruchomienie — nie rusza rejestru ani gniazda działającej kopii
    let beforeQuit = options.beforeQuit || null;
    let running = null;
    let server = null;
    const controlApi = {
        handle(cmd, fn) { handlers.set(cmd, fn); },
        remove(cmd) { handlers.delete(cmd); },
    };
    handlers.set('ping', () => ({ id, pong: true }));
    handlers.set('info', () => ({ id, name, version: app.getVersion(), coreVersion: CORE_VERSION, pid: process.pid, dataDir: dir, commands: [...handlers.keys()] }));
    handlers.set('status', () => (running ? running.update({}).status : {}));
    handlers.set('show', () => { if (onShow) onShow(); return Boolean(onShow); });
    handlers.set('quit', async () => {
        setTimeout(async () => {
            try { if (beforeQuit) await beforeQuit(); } catch {}
            app.quit();
        }, 50);
        return true;
    });
    function setStatus(patch) { return running ? running.update({ status: patch }).status : null; }
    function startControl() {
        const d = registry.dirs(root);
        fs.mkdirSync(d.run, { recursive: true });
        running = registry.markRunning(id, { name, version: app.getVersion(), coreVersion: CORE_VERSION }, root);
        server = control.serve(control.socketPath(d.run, id), handlers, (...a) => log.warn(...a));
        const stop = () => { try { if (server) server.close(); } catch {} try { if (running) running.clear(); } catch {} server = null; };
        app.on('will-quit', stop);
        process.on('exit', stop);
    }

    const updater = repo ? createUpdater({ repo, branch, appDir }) : null;

    // Jedna instancja aplikacji — drugie uruchomienie wywołuje onSecond (np. pokazuje okno z zasobnika)
    function singleInstance(onSecond) {
        if (!app.requestSingleInstanceLock()) {
            secondary = true;
            app.quit();
            return false;
        }
        onShow = onSecond || null;
        app.on('second-instance', () => onSecond && onSecond());
        return true;
    }

    // Wspólne kanały IPC: informacje, ustawienia, folder danych, aktualizacje, linki
    function registerIpc({ beforeRestart } = {}) {
        if (beforeRestart && !beforeQuit) beforeQuit = beforeRestart;
        ipcMain.handle('pitaya:app-info', () => ({
            id, name, version: app.getVersion(), repoUrl: updater ? updater.repoUrl : null,
            dataDir: dir, coreVersion: CORE_VERSION,
        }));
        ipcMain.handle('pitaya:settings-get', () => settings.all());
        ipcMain.handle('pitaya:settings-set', (event, patch) => settings.set(patch || {}));
        ipcMain.handle('pitaya:open-data-dir', () => shell.openPath(dir));
        ipcMain.handle('pitaya:open-external', (event, url) => {
            if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url);
        });
        if (updater) {
            ipcMain.handle('pitaya:update-check', () => updater.check());
            ipcMain.handle('pitaya:update-apply', (event) => updater.apply({
                onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('pitaya:update-progress', p); },
            }));
            ipcMain.on('pitaya:update-restart', async () => {
                try { if (beforeRestart) await beforeRestart(); } catch {}
                updater.restart();
            });
        }
    }

    app.whenReady().then(() => {
        if (secondary) return;
        register();
        try { startControl(); } catch (err) { log.warn('Kanał sterowania nie wystartował:', err.message); }
        log.info(`Start ${name} ${app.getVersion()} (Core ${CORE_VERSION})${firstRun ? ' — pierwsze uruchomienie' : ''}`);
    });

    return {
        id, name, folder, paths, firstRun, settings, log, updater, singleInstance, registerIpc, readJson, writeJson,
        // Wspólne dla całej rodziny Pitayas
        control: controlApi,
        setStatus,
        onQuit: (fn) => { beforeQuit = fn; },
        apps: () => registry.listApps(root),
        launch: (otherId) => registry.launch(otherId, root),
        send: (otherId, cmd, args, timeout) => registry.send(otherId, cmd, args, root, timeout),
    };
}

module.exports = { create, compareVersions, CORE_VERSION, registry, control };
