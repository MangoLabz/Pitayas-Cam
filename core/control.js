// ═══════ PITAYA CORE — KANAŁ STEROWANIA ═══════
// Każda działająca aplikacja nasłuchuje na lokalnym gnieździe:
//   Linux/macOS: ~/.config/Pitayas/run/<id>.sock     Windows: \\.\pipe\pitayas-<id>
// Protokół: jedna linia JSON na wiadomość.
//   → {"id":1,"cmd":"ping","args":{}}
//   ← {"id":1,"ok":true,"result":…}   albo   {"id":1,"ok":false,"error":"…"}
// Wbudowane polecenia (index.js): ping, info, status, show, quit. Aplikacja dopisuje własne przez core.control.handle().
const fs = require('fs');
const net = require('net');
const path = require('path');

function socketPath(runDir, id) {
    return process.platform === 'win32' ? `\\\\.\\pipe\\pitayas-${id}` : path.join(runDir, `${id}.sock`);
}

function serve(file, handlers, log = () => {}) {
    if (process.platform !== 'win32') { try { fs.unlinkSync(file); } catch {} }
    const server = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        sock.on('data', (chunk) => {
            buf += chunk;
            if (buf.length > 1e6) { sock.destroy(); return; }
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { sock.write(`${JSON.stringify({ ok: false, error: 'Niepoprawny JSON' })}\n`); continue; }
                const fn = handlers.get(msg.cmd);
                const reply = (body) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ id: msg.id, ...body })}\n`); };
                if (!fn) { reply({ ok: false, error: `Nieznane polecenie: ${msg.cmd}` }); continue; }
                Promise.resolve().then(() => fn(msg.args || {}))
                    .then((result) => reply({ ok: true, result: result === undefined ? null : result }))
                    .catch((err) => reply({ ok: false, error: err.message || String(err) }));
            }
        });
    });
    server.on('error', (err) => log('Kanał sterowania:', err.message));
    server.listen(file, () => { if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch {} } });
    return {
        close() {
            try { server.close(); } catch {}
            if (process.platform !== 'win32') { try { fs.unlinkSync(file); } catch {} }
        },
    };
}

// Jedno polecenie do innej aplikacji Pitayas
function call(file, cmd, args = {}, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(file);
        let buf = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('Aplikacja nie odpowiada')); }, timeout);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, cmd, args })}\n`));
        sock.on('data', (chunk) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            clearTimeout(timer);
            sock.end();
            let msg;
            try { msg = JSON.parse(buf.slice(0, nl)); } catch { reject(new Error('Niepoprawna odpowiedź')); return; }
            if (msg.ok) resolve(msg.result); else reject(new Error(msg.error || 'Błąd aplikacji'));
        });
        sock.on('error', (err) => { clearTimeout(timer); reject(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? new Error('Aplikacja nie jest uruchomiona') : err); });
    });
}

module.exports = { socketPath, serve, call };
