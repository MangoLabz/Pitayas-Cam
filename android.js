// ═══════ PITAYA CAM — ANDROID PRZEZ ADB ═══════
// Kamera telefonu z Androidem 12+ trafia przez scrcpy prosto do wirtualnej kamery (v4l2loopback).
// Kablem USB albo bez kabla (ADB przez Wi‑Fi). Na telefonie nic nie instalujesz —
// wystarczą włączone „Opcje programisty → Debugowanie USB”.
const { spawn, execFile } = require('child_process');

function run(cmd, args, timeout = 15000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '').toString(), err: (stderr || (err && err.message) || '').toString(), missing: err && err.code === 'ENOENT' });
        });
    });
}

// Telefony widoczne dla ADB, także te jeszcze niezatwierdzone („unauthorized”)
async function listDevices() {
    const r = await run('adb', ['devices', '-l']);
    if (r.missing) return { adb: false, devices: [] };
    const devices = [];
    for (const line of r.out.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2 || !parts[0]) continue;
        const [serial, state] = parts;
        const model = ((parts.find((p) => p.startsWith('model:')) || '').split(':')[1] || 'Android').replace(/_/g, ' ');
        const wifi = /:\d+$/.test(serial) || serial.includes('_adb-tls-connect');
        devices.push({ serial, state, model, transport: wifi ? 'wifi' : 'usb' });
    }
    return { adb: true, devices };
}

async function androidVersion(serial) {
    const r = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk']);
    const sdk = parseInt(r.out.trim(), 10) || 0;
    const rel = (await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'])).out.trim();
    return { sdk, release: rel };
}

// Aparaty telefonu: „--camera-id=0    (back, 4000x3000, fps=[15, 30])”
async function listCameras(serial) {
    const r = await run('scrcpy', ['--serial', serial, '--list-cameras'], 30000);
    if (r.missing) return { ok: false, error: 'Brak programu scrcpy — uruchom instalator Pitaya Cam.' };
    const text = r.out + r.err;
    const cameras = [];
    for (const m of text.matchAll(/--camera-id=(\S+)\s+\((\w+)(?:,\s*(\d+)x(\d+))?/g)) {
        cameras.push({ id: m[1], facing: m[2], width: +m[3] || 0, height: +m[4] || 0 });
    }
    if (!cameras.length) return { ok: false, error: explain(text) || 'Nie udało się odczytać aparatów telefonu.' };
    return { ok: true, cameras };
}

// Tłumaczenie typowych błędów scrcpy/adb na zrozumiałe komunikaty
function explain(text) {
    if (/unauthorized/i.test(text)) return 'Zatwierdź na telefonie okno „Zezwolić na debugowanie USB?”.';
    if (/(requires|require) (Android 12|API 31)|Camera.*not supported|camera mirroring is not supported/i.test(text)) return 'Kamera przez ADB wymaga Androida 12 lub nowszego.';
    if (/No matching camera size|camera-ar/i.test(text)) return 'Aparat nie ma trybu 16:9 — spróbuj innej jakości.';
    if (/Camera .* (in use|disconnected)|CAMERA_IN_USE|camera is used/i.test(text)) return 'Aparat telefonu jest zajęty przez inną aplikację — zamknij ją na telefonie.';
    if (/(could not|failed to) open .*\/dev\/video|v4l2/i.test(text)) return 'Wirtualna kamera /dev/video10 jest niedostępna — uruchom instalator Pitaya Cam (moduł v4l2loopback).';
    if (/device .*not found|no devices|offline/i.test(text)) return 'Telefon został odłączony albo jest niedostępny.';
    const line = text.split('\n').reverse().find((l) => /ERROR/.test(l));
    return line ? line.replace(/^.*ERROR:\s*/, '') : null;
}

// Uruchomienie kamery. onState({ state: 'starting' | 'running' | 'error' | 'stopped', message })
function start({ serial, cameraId, facing = 'back', quality = '1080', sink, onState }) {
    const maxSize = quality === '720' ? 1280 : 1920;
    let stopped = false;
    let proc = null;
    let output = '';

    const launch = (withAspect) => {
        const args = [
            '--serial', serial,
            '--video-source=camera',
            ...(cameraId ? [`--camera-id=${cameraId}`] : [`--camera-facing=${facing}`]),
            ...(withAspect ? ['--camera-ar=16:9'] : []),
            `--max-size=${maxSize}`,
            '--camera-fps=30',
            '--video-codec=h264',
            '--video-bit-rate=8M',
            '--no-audio',
            '--no-playback',
            '--no-window',
            `--v4l2-sink=${sink}`,
        ];
        output = '';
        let running = false;
        proc = spawn('scrcpy', args, { env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
        const onData = (d) => {
            output = (output + d.toString()).slice(-6000);
            if (!running && /v4l2 sink started|Device: .*\n.*(camera|Camera)|Texture:|INFO: Renderer/i.test(output) && /v4l2 sink started/i.test(output)) {
                running = true;
                onState({ state: 'running' });
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', (err) => {
            onState({ state: 'error', message: err.code === 'ENOENT' ? 'Brak programu scrcpy — uruchom instalator Pitaya Cam.' : err.message });
        });
        proc.on('close', (code) => {
            if (stopped) return onState({ state: 'stopped' });
            // Aparat bez trybu 16:9 — próbujemy jeszcze raz bez wymuszania proporcji
            if (withAspect && !running && /No matching camera size|camera-ar|aspect/i.test(output)) return launch(false);
            onState({ state: 'error', message: explain(output) || `scrcpy zakończył się (kod ${code}).` });
        });
    };

    onState({ state: 'starting' });
    // Wybudzenie ekranu — część telefonów nie oddaje aparatu przy zgaszonym ekranie
    run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']).then(() => launch(true));

    return {
        stop() {
            stopped = true;
            if (proc) { try { proc.kill('SIGTERM'); } catch {} }
        },
    };
}

// Przejście z kabla na Wi‑Fi: adb tcpip + adb connect na adres telefonu w sieci
async function enableWifi(serial) {
    const r = await run('adb', ['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
    const ip = (r.out.match(/inet (\d+\.\d+\.\d+\.\d+)/) || [])[1];
    if (!ip) return { ok: false, error: 'Telefon nie jest połączony z Wi‑Fi.' };
    const t = await run('adb', ['-s', serial, 'tcpip', '5555']);
    if (!t.ok) return { ok: false, error: explain(t.err) || t.err.trim() };
    await new Promise((res) => setTimeout(res, 2000));
    const c = await run('adb', ['connect', `${ip}:5555`]);
    if (!/connected to/i.test(c.out)) return { ok: false, error: `Nie udało się połączyć z ${ip}:5555 — ${(c.out + c.err).trim()}` };
    return { ok: true, serial: `${ip}:5555`, ip };
}

// Tryb przeglądarki (każdy Android, także starszy niż 12): adb reverse przekierowuje port
// komputera na telefon, a telefon otwiera http://localhost:PORT — przeglądarka uznaje localhost
// za bezpieczny adres, więc daje dostęp do kamery bez certyfikatu. Obraz idzie po kablu USB.
async function startBrowser(serial, port) {
    const r = await run('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    if (!r.ok) return { ok: false, error: explain(r.err) || `adb reverse nie zadziałał: ${r.err.trim()}` };
    await run('adb', ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    const url = `http://localhost:${port}/`;
    const o = await run('adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
    if (!o.ok || /Error|Exception/i.test(o.out + o.err)) return { ok: false, error: `Nie udało się otworzyć przeglądarki na telefonie: ${(o.out + o.err).trim()}` };
    return { ok: true, url };
}

async function stopBrowser(serial, port) {
    await run('adb', ['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
}

module.exports = { listDevices, androidVersion, listCameras, start, startBrowser, stopBrowser, enableWifi, explain };
