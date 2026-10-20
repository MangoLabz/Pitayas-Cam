// ═══════ PITAYA CAM — iPHONE (Wi‑Fi i kabel USB) ═══════
// iPhone łączy się z komputerem przez stronę w Safari. Po kablu działa to dzięki
// „Hotspotowi osobistemu”: Linux dostaje wtedy przez USB sieć (sterownik ipheth),
// a Safari otwiera stronę Pitaya Cam po tym kablu — bez Wi‑Fi i bez aplikacji z App Store.
// Safari udostępnia kamerę tylko na stronach HTTPS, dlatego serwer ma własny certyfikat.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_IFACE = /^(lo|docker|veth|virbr|tailscale|tun|tap|br-|zt|wg)/;

function ifaceDriver(name) {
    try { return path.basename(fs.readlinkSync(`/sys/class/net/${name}/device/driver`)); } catch { return ''; }
}

// Adresy, pod którymi iPhone może otworzyć stronę: najpierw kabel, potem Wi‑Fi, potem LAN
function listAddresses() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        if (SKIP_IFACE.test(name)) continue;
        const v4 = (addrs || []).find((a) => a.family === 'IPv4' && !a.internal);
        if (!v4) continue;
        const kind = ifaceDriver(name) === 'ipheth' ? 'usb' : /^wl/.test(name) ? 'wifi' : 'lan';
        out.push({ iface: name, ip: v4.address, kind });
    }
    const order = { usb: 0, wifi: 1, lan: 2 };
    return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

function readSys(file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// Stan iPhone'a na kablu: czy jest podłączony i czy działa już sieć po USB (Hotspot osobisty)
function usbStatus() {
    let name = null;
    try {
        for (const d of fs.readdirSync('/sys/bus/usb/devices')) {
            const base = `/sys/bus/usb/devices/${d}`;
            if (readSys(`${base}/idVendor`) !== '05ac') continue;   // Apple
            const product = readSys(`${base}/product`);
            if (/iPhone|iPad|iPod/i.test(product)) { name = product; break; }
        }
    } catch {}
    const net = listAddresses().find((a) => a.kind === 'usb');
    return { plugged: Boolean(name || net), name: name || (net ? 'iPhone' : null), network: Boolean(net), ip: net ? net.ip : null };
}

// Certyfikat HTTPS spełniający wymagania iOS (SHA‑256, SAN, serverAuth, ważność ≤ 398 dni).
// Tworzymy go raz i odnawiamy, gdy wygasa albo komputer ma nowe adresy.
function ensureCert(dir, log = () => {}) {
    const keyFile = path.join(dir, 'pitayacam-key.pem');
    const certFile = path.join(dir, 'pitayacam-cert.pem');
    const metaFile = path.join(dir, 'pitayacam-cert.json');
    const ips = [...new Set(['127.0.0.1', ...listAddresses().map((a) => a.ip)])];
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
    const fresh = meta && fs.existsSync(keyFile) && fs.existsSync(certFile)
        && Date.now() < meta.renewAfter
        && ips.every((ip) => meta.ips.includes(ip));
    if (!fresh) {
        const selfsigned = require('selfsigned');
        const names = [...new Set([...(meta ? meta.ips : []), ...ips])];
        const pems = selfsigned.generate([{ name: 'commonName', value: 'Pitaya Cam' }, { name: 'organizationName', value: 'Pitayas' }], {
            days: 397,
            keySize: 2048,
            algorithm: 'sha256',
            extensions: [
                { name: 'basicConstraints', cA: false },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
                { name: 'extKeyUsage', serverAuth: true },
                { name: 'subjectAltName', altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 2, value: os.hostname() },
                    ...names.map((ip) => ({ type: 7, ip })),
                ] },
            ],
        });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
        fs.writeFileSync(certFile, pems.cert);
        fs.writeFileSync(metaFile, JSON.stringify({ ips: names, renewAfter: Date.now() + 360 * 864e5 }));
        log('Utworzono certyfikat HTTPS dla adresów:', names.join(', '));
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

// Porty, których Safari (WebKit) i Chromium nie otworzą — m.in. IRC 6665–6669.
// Strona na takim porcie po prostu się nie wczyta, więc zamieniamy go na bezpieczny.
const BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
    104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
    532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
    6665, 6666, 6667, 6668, 6669, 6697, 10080]);
const DEFAULT_PORT = 2137;
function safePort(port) {
    const p = parseInt(port, 10);
    return Number.isInteger(p) && p >= 1024 && p <= 65535 && !BLOCKED_PORTS.has(p) ? p : DEFAULT_PORT;
}

module.exports = { listAddresses, usbStatus, ensureCert, safePort, BLOCKED_PORTS: [...BLOCKED_PORTS], DEFAULT_PORT };
