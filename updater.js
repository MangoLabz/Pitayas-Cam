// ═══════ AKTUALIZATOR GITHUB ═══════
// Wspólny moduł aktualizacji aplikacji Pitayas.
//  • uruchomienie z klonu gita  → git fetch + git pull (i npm install, gdy zmieniły się zależności)
//  • AppImage                    → pobranie nowego AppImage z najnowszego release'u i podmiana pliku
//  • inne paczki (rpm, exe…)     → otwarcie strony release'u w przeglądarce
const { app, shell } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

async function download(url, dest, userAgent) {
    const res = await request(url, userAgent);
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`Pobieranie nie powiodło się (HTTP ${res.statusCode})`);
    }
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
    });
}

function compareVersions(a, b) {
    const pa = String(a).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

function createUpdater({ repo, branch = 'main', appDir }) {
    const userAgent = `${repo.split('/')[1]}-Updater`;
    const isGitClone = !app.isPackaged && fs.existsSync(path.join(appDir, '.git'));
    let lastRelease = null;

    function pickAsset(release) {
        const assets = (release && release.assets) || [];
        if (process.env.APPIMAGE) return assets.find(a => /\.AppImage$/i.test(a.name));
        if (process.platform === 'win32') return assets.find(a => /\.exe$/i.test(a.name));
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

            const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, userAgent);
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
                canAutoInstall: Boolean(process.env.APPIMAGE && asset),
                hasUpdate: Boolean(latestVersion) && compareVersions(latestVersion, currentVersion) > 0
            };
        } catch (err) {
            return { ok: false, currentVersion, error: err.message };
        }
    }

    async function apply() {
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

            const release = lastRelease || await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, userAgent);
            if (!release) return { ok: false, error: 'Brak opublikowanych wersji na GitHubie' };
            const asset = pickAsset(release);
            if (process.env.APPIMAGE && asset) {
                const target = process.env.APPIMAGE;
                const tmp = `${target}.download`;
                await download(asset.browser_download_url, tmp, userAgent);
                fs.chmodSync(tmp, 0o755);
                fs.renameSync(tmp, target);
                return { ok: true, restart: true };
            }
            await shell.openExternal(release.html_url);
            return { ok: true, openedBrowser: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    function restart() {
        // AppImage montuje się w /tmp — restartujemy sam plik AppImage, a nie binarkę z montowania
        app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : undefined);
        app.exit(0);
    }

    return { check, apply, restart, repoUrl: `https://github.com/${repo}` };
}

module.exports = { createUpdater };
