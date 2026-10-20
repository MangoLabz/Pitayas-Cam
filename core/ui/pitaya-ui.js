// ═══════ PITAYA UI ═══════
// Wspólna obsługa okna (pasek tytułu, modale, toasty) i aktualizacji z GitHuba.
// Część Pitaya Core — window.pitayaBridge tworzy core/bridge.js
// (minimize, close, getAppInfo, openDataDir, checkUpdate, applyUpdate, restart, openExternal).
(function () {
    const bridge = window.pitayaBridge;
    const $ = (id) => document.getElementById(id);

    function escapeHTML(str) {
        return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showToast(message, type = 'info') {
        let box = document.querySelector('.m-toasts');
        if (!box) {
            box = document.createElement('div');
            box.className = 'm-toasts';
            document.body.appendChild(box);
        }
        const toast = document.createElement('div');
        toast.className = `m-toast ${type}`;
        toast.textContent = message;
        box.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('out');
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    }

    function openModal(id) {
        const el = $(id);
        if (el) el.classList.add('active');
    }

    function closeModal(id) {
        const el = $(id);
        if (el) el.classList.remove('active');
    }

    document.querySelectorAll('.m-modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.querySelectorAll('.m-modal-overlay.active').forEach(m => m.classList.remove('active'));
    });

    // Przyciski okna
    document.querySelectorAll('[data-win]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.win === 'min') bridge.minimize();
            else if (btn.dataset.win === 'close') bridge.close();
        });
    });

    // ───── Aktualizacje ─────
    let checking = false;

    function setUpdateBadge(show) {
        const pill = $('updatePill');
        if (pill) pill.classList.toggle('show', show);
        const settingsBtn = $('btnSettings');
        if (settingsBtn) settingsBtn.classList.toggle('has-dot', show);
    }

    function renderUpdate(res) {
        const status = $('updateStatusText');
        const details = $('updateDetails');
        const info = $('updateInfo');
        const applyBtn = $('btnApplyUpdate');
        if (!status) return;

        $('appVersionText').textContent = res.currentVersion + (res.localSha ? ` (${res.localSha})` : '');
        details.classList.toggle('show', Boolean(res.hasUpdate));
        if (!res.hasUpdate) {
            status.textContent = res.mode === 'release' && !res.latestVersion
                ? 'Brak opublikowanych wersji na GitHubie.'
                : 'Masz najnowszą wersję.';
            status.className = 'm-update-status t-ok';
            return;
        }

        status.className = 'm-update-status t-warn';
        if (res.mode === 'git') {
            status.textContent = `Dostępne zmiany: ${res.behind} ${res.behind === 1 ? 'commit' : 'commitów'} (${res.localSha} → ${res.remoteSha})`;
            info.innerHTML = res.commits.map(c =>
                `<div class="m-commit"><code>${escapeHTML(c.sha)}</code><span>${escapeHTML(c.message)}</span></div>`
            ).join('');
            applyBtn.textContent = 'Zainstaluj aktualizację';
        } else {
            status.textContent = `Dostępna wersja ${res.latestVersion} (masz ${res.currentVersion})`;
            info.innerHTML = res.notes ? `<div class="m-notes">${escapeHTML(res.notes)}</div>` : '';
            const needsPassword = ['rpm', 'deb'].includes(res.installKind);
            applyBtn.textContent = res.canAutoInstall ? 'Zainstaluj aktualizację' : 'Pobierz ze strony GitHub';
            applyBtn.title = needsPassword ? 'System poprosi o hasło administratora' : '';
            if (needsPassword && res.canAutoInstall) status.textContent += ' · instalacja poprosi o hasło administratora';
        }
        applyBtn.disabled = false;
        applyBtn.style.display = '';
    }

    async function checkForUpdates({ silent = false } = {}) {
        if (checking) return;
        checking = true;
        const btn = $('btnCheckUpdate');
        const status = $('updateStatusText');
        if (btn) btn.disabled = true;
        if (status && !silent) {
            status.textContent = 'Sprawdzanie w GitHubie…';
            status.className = 'm-update-status';
        }
        try {
            const res = await bridge.checkUpdate();
            if (!res.ok) {
                if (status) {
                    status.textContent = `Nie udało się sprawdzić: ${res.error}`;
                    status.className = 'm-update-status t-err';
                }
                if (!silent) showToast(`Błąd sprawdzania aktualizacji: ${res.error}`, 'error');
                return;
            }
            renderUpdate(res);
            setUpdateBadge(res.hasUpdate);
            if (res.hasUpdate) showToast('Dostępna jest nowa wersja — otwórz Ustawienia, aby zaktualizować.', 'info');
            else if (!silent) showToast('Masz najnowszą wersję!', 'success');
        } finally {
            checking = false;
            if (btn) btn.disabled = false;
        }
    }

    async function applyUpdate() {
        const applyBtn = $('btnApplyUpdate');
        const restartBtn = $('btnRestartApp');
        applyBtn.disabled = true;
        applyBtn.textContent = 'Aktualizowanie…';
        const res = await bridge.applyUpdate();
        if (!res.ok) {
            showToast(`Błąd aktualizacji: ${res.error}`, 'error');
            applyBtn.disabled = false;
            applyBtn.textContent = 'Spróbuj ponownie';
            return;
        }
        if (res.openedBrowser) {
            showToast('Otwarto stronę z nową wersją w przeglądarce.', 'info');
            applyBtn.disabled = false;
            applyBtn.textContent = 'Pobierz ze strony GitHub';
            return;
        }
        setUpdateBadge(false);
        applyBtn.style.display = 'none';
        restartBtn.style.display = '';
        $('updateStatusText').textContent = 'Zaktualizowano! Uruchom aplikację ponownie.';
        $('updateStatusText').className = 'm-update-status t-ok';
        showToast('Aktualizacja zainstalowana — uruchom ponownie aplikację.', 'success');
    }

    // Postęp aktualizacji: pobieranie pakietu, potem instalacja (systemowe okno z hasłem)
    if (bridge.onUpdateProgress) {
        bridge.onUpdateProgress((p) => {
            const applyBtn = $('btnApplyUpdate');
            const status = $('updateStatusText');
            if (!applyBtn || !status) return;
            if (p.stage === 'download') {
                applyBtn.textContent = `Pobieranie ${p.percent}%…`;
                status.textContent = `Pobieranie nowej wersji${p.total ? ` (${(p.total / 1048576).toFixed(0)} MB)` : ''}…`;
            } else if (p.stage === 'install') {
                applyBtn.textContent = 'Instalowanie…';
                status.textContent = 'Podaj hasło w oknie systemowym, aby zainstalować aktualizację.';
                status.className = 'm-update-status t-warn';
            }
        });
    }

    function bindUpdateUI() {
        const check = $('btnCheckUpdate');
        if (check) check.addEventListener('click', () => checkForUpdates());
        const apply = $('btnApplyUpdate');
        if (apply) apply.addEventListener('click', applyUpdate);
        const restart = $('btnRestartApp');
        if (restart) restart.addEventListener('click', () => bridge.restart());
        const pill = $('updatePill');
        if (pill) pill.addEventListener('click', () => openModal('modalSettings'));
        const dataBtn = $('btnOpenDataDir');
        if (dataBtn) dataBtn.addEventListener('click', () => bridge.openDataDir());
        const repo = $('repoLink');
        if (repo) repo.addEventListener('click', (e) => {
            e.preventDefault();
            bridge.openExternal(repo.dataset.href);
        });
    }

    bindUpdateUI();
    bridge.getAppInfo().then(info => {
        document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = `v${info.version}`; });
        if ($('appVersionText')) $('appVersionText').textContent = info.version;
        if ($('dataDirText')) $('dataDirText').textContent = info.dataDir;
        const repo = $('repoLink');
        if (repo) {
            repo.dataset.href = info.repoUrl;
            repo.textContent = info.repoUrl.replace(/^https:\/\//, '');
        }
    });
    setTimeout(() => checkForUpdates({ silent: true }), 2500);

    window.PitayaUI = { showToast, openModal, closeModal, checkForUpdates, escapeHTML };
})();
