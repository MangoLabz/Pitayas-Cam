// ═══════ PITAYA CORE — MOST DLA OKNA ═══════
// Buduje obiekt window.pitayaBridge, z którego korzysta ui/pitaya-ui.js.
//  • aplikacja z contextIsolation (preload.js):
//      contextBridge.exposeInMainWorld('pitayaBridge', require('./core/bridge').makeBridge(ipcRenderer));
//  • aplikacja z nodeIntegration (skrypt w oknie):
//      window.pitayaBridge = require('./core/bridge').makeBridge(require('electron').ipcRenderer);
// Kanały pitaya:win-minimize i pitaya:win-close obsługuje sama aplikacja (każda inaczej chowa okno).
function makeBridge(ipcRenderer) {
    return {
        minimize: () => ipcRenderer.send('pitaya:win-minimize'),
        close: () => ipcRenderer.send('pitaya:win-close'),
        getAppInfo: () => ipcRenderer.invoke('pitaya:app-info'),
        getSettings: () => ipcRenderer.invoke('pitaya:settings-get'),
        setSettings: (patch) => ipcRenderer.invoke('pitaya:settings-set', patch),
        openDataDir: () => ipcRenderer.invoke('pitaya:open-data-dir'),
        checkUpdate: () => ipcRenderer.invoke('pitaya:update-check'),
        applyUpdate: () => ipcRenderer.invoke('pitaya:update-apply'),
        onUpdateProgress: (cb) => ipcRenderer.on('pitaya:update-progress', (e, p) => cb(p)),
        restart: () => ipcRenderer.send('pitaya:update-restart'),
        openExternal: (url) => ipcRenderer.invoke('pitaya:open-external', url),
    };
}

module.exports = { makeBridge };
