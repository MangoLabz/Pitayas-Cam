// ═══════ PITAYA CAM — WIRTUALNA KAMERA ═══════
// /dev/video10 (v4l2loopback) to kamera, którą widzą Discord, OBS, przeglądarki.
//  • nazwa w systemie: „Pitaya Cam” (stare instalacje mają „Mango Cam” + „Mango Feed”),
//  • plansza „aplikacja nieaktywna”: usługa systemd użytkownika nadaje obraz z logo, gdy
//    Pitaya Cam nie nadaje — dzięki temu kamera nie znika z listy w innych programach.
//    Pitaya Cam zatrzymuje planszę przed nadawaniem i włącza ją z powrotem po zatrzymaniu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEVICE = '/dev/video10';
const VIDEO_NR = 10;
const LABEL = 'Pitaya Cam';
const UNIT = 'pitaya-cam-idle.service';

function run(cmd, args, timeout = 30000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
            resolve({ ok: !err, code: err ? err.code : 0, out: (stdout || '').toString(), err: (stderr || (err && err.message) || '').toString() });
        });
    });
}

function readSys(file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function which(cmd) {
    for (const dir of (process.env.PATH || '/usr/bin:/bin').split(':').concat(['/usr/bin', '/bin'])) {
        const p = path.join(dir, cmd);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
}

// Stan: czy jest /dev/video10, jak się nazywa, czy trzeba poprawić konfigurację modułu
function status() {
    const name = readSys(`/sys/class/video4linux/video${VIDEO_NR}/name`);
    const others = [];
    try {
        for (const d of fs.readdirSync('/sys/class/video4linux')) {
            if (d === `video${VIDEO_NR}`) continue;
            const n = readSys(`/sys/class/video4linux/${d}/name`);
            if (/mango|pitaya/i.test(n)) others.push({ device: `/dev/${d}`, name: n });
        }
    } catch {}
    return {
        device: DEVICE,
        exists: fs.existsSync(DEVICE),
        name: name || null,
        others,
        needsFix: !fs.existsSync(DEVICE) || name !== LABEL || others.length > 0,
    };
}

// Poprawka konfiguracji (wymaga hasła administratora — pkexec): jedna kamera „Pitaya Cam”
async function fix() {
    const pkexec = which('pkexec');
    if (!pkexec) return { ok: false, error: 'Brak pkexec — uruchom instalator Pitaya Cam.' };
    await idle.stop();
    const script = [
        'set -e',
        'rm -f /etc/modprobe.d/mangocam.conf /etc/modules-load.d/mangocam.conf',
        `echo 'options v4l2loopback devices=1 video_nr=${VIDEO_NR} card_label="${LABEL}" exclusive_caps=1 max_width=3840 max_height=2160' > /etc/modprobe.d/pitayacam.conf`,
        "echo v4l2loopback > /etc/modules-load.d/pitayacam.conf",
        'modprobe -r v4l2loopback 2>/dev/null || { echo BUSY; exit 3; }',
        'modprobe v4l2loopback',
    ].join('\n');
    const r = await run(pkexec, ['/bin/bash', '-c', script], 120000);
    let result;
    if (r.ok) result = { ok: true };
    else if (/BUSY/.test(r.out + r.err) || r.code === 3) {
        result = { ok: true, reboot: true, message: 'Ustawienia zapisane. Kamerę używa teraz inny program — nowa nazwa pojawi się po zamknięciu tego programu albo po ponownym uruchomieniu komputera.' };
    } else if (r.code === 126 || /dismissed|Not authorized/i.test(r.err)) {
        result = { ok: false, error: 'Anulowano — nie podano hasła administratora.' };
    } else {
        result = { ok: false, error: (r.err || r.out).trim().split('\n').slice(-2).join(' ') };
    }
    await idle.start();
    return result;
}

// ───── Plansza „aplikacja nieaktywna” (systemd --user) ─────
const idle = {
    enabled: true,
    image: null,

    // Zapisuje usługę z planszą (ffmpeg nadaje obraz 10 kl/s) i ją włącza przy logowaniu
    async install(dataDir, sourceImage) {
        if (process.platform !== 'linux' || !which('systemctl')) return false;
        const ffmpeg = which('ffmpeg');
        if (!ffmpeg) return false;
        this.image = path.join(dataDir, 'idle.png');
        try {
            const src = fs.readFileSync(sourceImage);
            if (!fs.existsSync(this.image) || !fs.readFileSync(this.image).equals(src)) fs.writeFileSync(this.image, src);
        } catch { return false; }
        const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
        const unitFile = path.join(unitDir, UNIT);
        const unit = [
            '[Unit]',
            'Description=Pitaya Cam — plansza „aplikacja nieaktywna” w wirtualnej kamerze',
            `ConditionPathExists=${DEVICE}`,
            '',
            '[Service]',
            `ExecStart=${ffmpeg} -hide_banner -loglevel error -re -loop 1 -framerate 10 -i ${this.image} -vf format=yuv420p -r 10 -f v4l2 ${DEVICE}`,
            'Restart=always',
            'RestartSec=5',
            '',
            '[Install]',
            'WantedBy=default.target',
            '',
        ].join('\n');
        let changed = false;
        try {
            fs.mkdirSync(unitDir, { recursive: true });
            if (!fs.existsSync(unitFile) || fs.readFileSync(unitFile, 'utf8') !== unit) { fs.writeFileSync(unitFile, unit); changed = true; }
        } catch { return false; }
        if (changed) await run('systemctl', ['--user', 'daemon-reload']);
        await run('systemctl', ['--user', 'enable', UNIT]);
        return true;
    },

    async stop() {
        await run('systemctl', ['--user', 'stop', UNIT]);
        // chwila na zwolnienie urządzenia, zanim zacznie do niego pisać właściwy obraz
        await new Promise((r) => setTimeout(r, 300));
    },

    async start() {
        if (!this.enabled) return;
        await run('systemctl', ['--user', 'start', UNIT]);
    },

    async disable() {
        this.enabled = false;
        await run('systemctl', ['--user', 'disable', '--now', UNIT]);
    },

    async isActive() {
        const r = await run('systemctl', ['--user', 'is-active', UNIT]);
        return r.out.trim() === 'active';
    },
};

module.exports = { DEVICE, LABEL, status, fix, idle };
