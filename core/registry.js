// ═══════ PITAYA CORE — REJESTR APLIKACJI ═══════
// Bez Electrona — z tego modułu może korzystać każda aplikacja i przyszły Pitaya Hub.
//
//   ~/.config/Pitayas/
//     apps/<id>.json     wpis aplikacji: nazwa, wersja, jak ją uruchomić, ikona, folder danych…
//     run/<id>.json      tylko gdy działa: pid, start, adres gniazda sterowania, status aplikacji
//     run/<id>.sock      gniazdo sterowania (control.js)
//     core.json          stary zbiorczy spis (zostaje dla zgodności)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const control = require('./control');

const SCHEMA = 2;

function rootDir() {
    if (process.env.PITAYAS_HOME) return process.env.PITAYAS_HOME;
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Pitayas');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Pitayas');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Pitayas');
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function dirs(root = rootDir()) {
    return { root, apps: path.join(root, 'apps'), run: path.join(root, 'run'), coreFile: path.join(root, 'core.json') };
}

// Wpis aplikacji (zapisywany przy każdym starcie)
function register(entry, root) {
    const d = dirs(root);
    const full = { schema: SCHEMA, ...entry, lastRun: new Date().toISOString() };
    writeJson(path.join(d.apps, `${entry.id}.json`), full);
    // Zgodność wstecz: zbiorczy core.json
    const reg = readJson(d.coreFile, { apps: {} });
    reg.apps = reg.apps || {};
    reg.apps[entry.id] = { name: entry.name, folder: entry.folder, version: entry.version, executable: entry.executable, packaged: entry.packaged, lastRun: full.lastRun };
    reg.coreVersion = entry.coreVersion;
    reg.schema = SCHEMA;
    try { writeJson(d.coreFile, reg); } catch {}
    return full;
}

// Plik „działam” — znika przy zamknięciu; po awarii rozpoznajemy go po martwym pid
function markRunning(id, info, root) {
    const d = dirs(root);
    const file = path.join(d.run, `${id}.json`);
    let state = { id, pid: process.pid, startedAt: new Date().toISOString(), control: control.socketPath(d.run, id), status: {}, ...info };
    writeJson(file, state);
    return {
        file,
        update(patch) {
            state = { ...state, ...patch, status: { ...state.status, ...(patch.status || {}) }, updatedAt: new Date().toISOString() };
            try { writeJson(file, state); } catch {}
            return state;
        },
        clear() {
            const cur = readJson(file, null);
            if (!cur || cur.pid === process.pid) { try { fs.unlinkSync(file); } catch {} }
        },
    };
}

function runState(id, root) {
    const st = readJson(path.join(dirs(root).run, `${id}.json`), null);
    return st && pidAlive(st.pid) ? st : null;
}

// Wszystkie aplikacje Pitayas na tym komputerze (i które z nich działają)
function listApps(root) {
    const d = dirs(root);
    const out = {};
    let files = [];
    try { files = fs.readdirSync(d.apps).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) {
        const e = readJson(path.join(d.apps, f), null);
        if (e && e.id) out[e.id] = e;
    }
    // Aplikacje znane tylko ze starego core.json (jeszcze nie uruchomione z Core 0.2)
    const legacy = readJson(d.coreFile, { apps: {} }).apps || {};
    for (const [id, e] of Object.entries(legacy)) if (!out[id]) out[id] = { id, ...e, legacy: true };
    return Object.values(out).map((e) => {
        const run = runState(e.id, root);
        return { ...e, running: Boolean(run), run };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl'));
}

function getApp(id, root) { return listApps(root).find((a) => a.id === id) || null; }

// Uruchomienie innej aplikacji (albo pokazanie okna, gdy już działa)
async function launch(id, root) {
    const a = getApp(id, root);
    if (!a) throw new Error(`Nie znam aplikacji „${id}”`);
    if (a.running) { await send(id, 'show', {}, root).catch(() => {}); return { already: true }; }
    const l = a.launch || { command: a.executable, args: [] };
    if (!l.command || !fs.existsSync(l.command)) throw new Error(`Nie znaleziono programu: ${l.command || '(brak)'}`);
    const child = spawn(l.command, l.args || [], { cwd: l.cwd || path.dirname(l.command), detached: true, stdio: 'ignore', env: { ...process.env, ...(l.env || {}) } });
    child.unref();
    return { pid: child.pid };
}

function send(id, cmd, args = {}, root, timeout) {
    const run = runState(id, root);
    if (!run) return Promise.reject(new Error('Aplikacja nie jest uruchomiona'));
    return control.call(run.control, cmd, args, timeout);
}

module.exports = { SCHEMA, rootDir, dirs, readJson, writeJson, register, markRunning, runState, listApps, getApp, launch, send, pidAlive };
