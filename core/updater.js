// ═══════ AKTUALIZATOR GITHUB ═══════
// Aktualizator GitHub — część Pitaya Core.
//  • uruchomienie z klonu gita  → git fetch + git pull (i npm install, gdy zmieniły się zależności)
//  • AppImage                    → pobranie nowego AppImage z najnowszego release'u i podmiana pliku
//  • pakiet RPM / DEB            → pobranie nowego pakietu i instalacja przez pkexec (systemowe okno z hasłem)
//  • inne paczki (rpm, exe…)     → otwarcie strony release'u w przeglądarce
const { app, shell } = require('electron');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

function run(cmd, args, cwd, timeout = 60000) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).toString().trim()));
            resolve(stdout.toString().trim());
        });
    });
}

function request(url, userAgent, redirects = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': userAgent, 'Accept': 'application/vnd.github+json' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(request(res.headers.location, userAgent, redirects - 1));
            }
            resolve(res);
        }).on('error', reject);
    });
}

async function fetchJson(url, userAgent) {
    const res = await request(url, userAgent);
    let data = '';
    for await (const chunk of res) data += chunk;
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) throw new Error(`GitHub HTTP ${res.statusCode}`);
    return JSON.parse(data);
}

async function download(url, dest, userAgent, onProgress) {
    const res = await request(url, userAgent);
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`Pobieranie nie powiodło się (HTTP ${res.statusCode})`);
    }
    const total = +res.headers['content-length'] || 0;
    let got = 0, lastPct = -1;
    res.on('data', (chunk) => {
        got += chunk.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (onProgress && pct !== lastPct) { lastPct = pct; onProgress({ stage: 'download', percent: pct, bytes: got, total }); }
    });
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
    });
}

// Porównanie wersji jak w semver: 0.1.0 > 0.1.0-beta.2 > 0.1.0-beta > 0.0.9
function parseVersion(v) {
    const [core, pre = ''] = String(v).trim().replace(/^v/i, '').split(/-(.*)/s);
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
}

function compareVersions(a, b) {
    const pa = parseVersion(a), pb = parseVersion(b);
    for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
        const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    // Wersja bez dopisku (stabilna) jest nowsza niż ta sama z dopiskiem (beta)
    if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : (pa.pre.length ? -1 : 1);
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i], y = pb.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny && +x !== +y) return +x > +y ? 1 : -1;
        if (nx !== ny) return nx ? -1 : 1;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

// /releases/latest pomija wydania testowe (pre-release), więc bierzemy całą listę
// i wybieramy najwyższą wersję spośród opublikowanych (bez szkiców)
async function fetchNewestRelease(repo, userAgent) {
    const list = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=30`, userAgent);
    const published = (Array.isArray(list) ? list : []).filter(r => !r.draft && (r.tag_name || r.name));
    published.sort((x, y) => compareVersions(y.tag_name || y.name, x.tag_name || x.name));
    return published[0] || null;
}

function whichSync(cmd) {
    for (const dir of (process.env.PATH || '/usr/bin:/bin').split(':').concat(['/usr/bin', '/usr/sbin', '/bin'])) {
        const p = path.join(dir, cmd);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
}

// Jak zainstalowano aplikację: z pakietu systemowego (rpm/deb), jako AppImage itd.
let cachedKind = null;
function installKind() {
    if (cachedKind) return cachedKind;
    cachedKind = 'other';
    if (process.env.APPIMAGE) cachedKind = 'appimage';
    // Windows: wersja przenośna (electron-builder ustawia PORTABLE_EXECUTABLE_FILE) albo instalator NSIS
    else if (process.platform === 'win32') cachedKind = process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : app.isPackaged ? 'nsis' : 'other';
    else if (process.platform === 'linux' && app.isPackaged) {
        const exe = process.execPath;
        const owns = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } };
        if (whichSync('rpm') && owns('rpm', ['-qf', exe])) cachedKind = 'rpm';
        else if (whichSync('dpkg') && owns('dpkg', ['-S', exe])) cachedKind = 'deb';
    }
    return cachedKind;
}

// Instalacja pobranego pakietu z uprawnieniami administratora (pkexec pokazuje systemowe okno z hasłem)
async function installPackage(kind, file) {
    const pkexec = whichSync('pkexec');
    if (!pkexec) throw new Error('Brak programu pkexec — zainstaluj pobrany pakiet ręcznie.');
    let cmd;
    if (kind === 'rpm') {
        const dnf = whichSync('dnf') || whichSync('dnf5') || whichSync('yum');
        cmd = dnf ? [dnf, 'install', '-y', file] : [whichSync('rpm'), '-U', '--replacepkgs', file];
    } else {
        const apt = whichSync('apt-get');
        cmd = apt ? [apt, 'install', '-y', file] : [whichSync('dpkg'), '-i', file];
    }
    try {
        await run(pkexec, cmd, os.tmpdir(), 15 * 60 * 1000);
    } catch (err) {
        // 126: okno z hasłem zamknięte, 127: brak uprawnień
        if (/126|dismissed|Not authorized|127/i.test(err.message)) throw new Error('Instalacja anulowana — nie podano hasła administratora.');
        throw new Error(`Instalacja pakietu nie powiodła się: ${err.message.split('\n').slice(-3).join(' ')}`);
    }
}

function createUpdater({ repo, branch = 'main', appDir }) {
    const userAgent = `${repo.split('/')[1]}-Updater`;
    const isGitClone = !app.isPackaged && fs.existsSync(path.join(appDir, '.git'));
    let lastRelease = null;
    let pending = null;   // Windows: pobrana aktualizacja czekająca na zamknięcie aplikacji

    function pickAsset(release) {
        const assets = (release && release.assets) || [];
        const kind = installKind();
        if (kind === 'appimage') return assets.find(a => /\.AppImage$/i.test(a.name));
        if (kind === 'nsis') return assets.find(a => /setup.*\.exe$/i.test(a.name)) || assets.find(a => /\.exe$/i.test(a.name) && !/portable/i.test(a.name));
        if (kind === 'portable') return assets.find(a => /portable.*\.exe$/i.test(a.name));
        if (kind === 'rpm') return assets.find(a => /\.rpm$/i.test(a.name) && /x86_64|amd64|noarch/i.test(a.name) === (process.arch === 'x64'));
        if (kind === 'deb') return assets.find(a => /\.deb$/i.test(a.name));
        return null;
    }

    async function check() {
        const currentVersion = app.getVersion();
        try {
            if (isGitClone) {
                await run('git', ['fetch', '--quiet', 'origin', branch], appDir, 30000);
                const localSha = await run('git', ['rev-parse', '--short', 'HEAD'], appDir);
                const remoteSha = await run('git', ['rev-parse', '--short', `origin/${branch}`], appDir);
                const behind = parseInt(await run('git', ['rev-list', '--count', `HEAD..origin/${branch}`], appDir), 10) || 0;
                const log = behind > 0
                    ? await run('git', ['log', '--format=%h%x09%s%x09%cI', '-n', '10', `HEAD..origin/${branch}`], appDir)
                    : '';
                const commits = log ? log.split('\n').map(line => {
                    const [sha, message, date] = line.split('\t');
                    return { sha, message, date };
                }) : [];
                return { ok: true, mode: 'git', currentVersion, localSha, remoteSha, behind, commits, hasUpdate: behind > 0 };
            }

            const release = await fetchNewestRelease(repo, userAgent);
            lastRelease = release;
            if (!release) return { ok: true, mode: 'release', currentVersion, hasUpdate: false, latestVersion: null };
            const latestVersion = (release.tag_name || release.name || '').replace(/^v/i, '');
            const asset = pickAsset(release);
            return {
                ok: true,
                mode: 'release',
                currentVersion,
                latestVersion,
                notes: release.body || '',
                url: release.html_url,
                prerelease: Boolean(release.prerelease),
                installKind: installKind(),
                canAutoInstall: Boolean(asset && ['appimage', 'rpm', 'deb', 'nsis', 'portable'].includes(installKind())),
                hasUpdate: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0
            };
        } catch (err) {
            return { ok: false, currentVersion, error: err.message };
        }
    }

    async function apply({ onProgress } = {}) {
        try {
            if (isGitClone) {
                const before = await run('git', ['rev-parse', 'HEAD'], appDir);
                await run('git', ['pull', '--ff-only', 'origin', branch], appDir, 120000);
                const after = await run('git', ['rev-parse', 'HEAD'], appDir);
                const changed = before === after ? '' : await run('git', ['diff', '--name-only', before, after], appDir);
                if (/^package(-lock)?\.json$/m.test(changed)) {
                    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], appDir, 600000);
                }
                return { ok: true, restart: true };
            }

            const release = lastRelease || await fetchNewestRelease(repo, userAgent);
            if (!release) return { ok: false, error: 'Brak opublikowanych wersji na GitHubie' };
            const asset = pickAsset(release);
            const kind = installKind();
            if (kind === 'appimage' && asset) {
                const target = process.env.APPIMAGE;
                const tmp = `${target}.download`;
                await download(asset.browser_download_url, tmp, userAgent, onProgress);
                fs.chmodSync(tmp, 0o755);
                fs.renameSync(tmp, target);
                return { ok: true, restart: true };
            }
            if ((kind === 'rpm' || kind === 'deb') && asset) {
                const file = path.join(os.tmpdir(), asset.name);
                await download(asset.browser_download_url, file, userAgent, onProgress);
                if (onProgress) onProgress({ stage: 'install' });
                try { await installPackage(kind, file); } finally { fs.rmSync(file, { force: true }); }
                return { ok: true, restart: true };
            }
            // Windows (instalator): pobieramy nowy Setup.exe, a po „Uruchom ponownie” instaluje się po cichu i sam uruchamia aplikację
            if (kind === 'nsis' && asset) {
                const file = path.join(os.tmpdir(), asset.name);
                await download(asset.browser_download_url, file, userAgent, onProgress);
                pending = { kind, file };
                return { ok: true, restart: true };
            }
            // Windows (wersja przenośna): nowy plik obok starego, podmiana po zamknięciu aplikacji
            if (kind === 'portable' && asset) {
                const target = process.env.PORTABLE_EXECUTABLE_FILE;
                const file = `${target}.new`;
                await download(asset.browser_download_url, file, userAgent, onProgress);
                pending = { kind, file, target };
                return { ok: true, restart: true };
            }
            await shell.openExternal(release.html_url);
            return { ok: true, openedBrowser: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    function restart() {
        if (pending && pending.kind === 'nsis') {
            // /S = bez okien, --force-run = uruchom aplikację po instalacji (instalator sam zamyka starą wersję)
            spawn(pending.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            setTimeout(() => app.exit(0), 300);
            return;
        }
        if (pending && pending.kind === 'portable') {
            const q = (x) => `"${x.replace(/"/g, '')}"`;
            const script = `ping -n 3 127.0.0.1 >nul & move /y ${q(pending.file)} ${q(pending.target)} >nul & start "" ${q(pending.target)}`;
            spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
            setTimeout(() => app.exit(0), 300);
            return;
        }
        // AppImage montuje się w /tmp — restartujemy sam plik AppImage, a nie binarkę z montowania
        app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
        app.exit(0);
    }

    return { check, apply, restart, installKind, repoUrl: `https://github.com/${repo}` };
}

module.exports = { createUpdater, compareVersions };
