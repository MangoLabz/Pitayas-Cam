const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const sudo = require('sudo-prompt');
const { exec, spawn } = require('child_process');

let win;

function createInstallerWindow() {
    win = new BrowserWindow({
        width: 440,
        height: 480,
        resizable: false,
        frame: false,
        backgroundColor: '#0c0c0e',
        icon: path.join(__dirname, 'build', 'icons', '512x512.png'),
                            webPreferences: {
                                nodeIntegration: true,
                            contextIsolation: false
                            }
    });

    win.loadFile('installer.html');
}

app.whenReady().then(createInstallerWindow);

ipcMain.on('start-install', () => {
    const options = {
        name: 'Pitaya Cam Installer'
    };

    const scriptPath = path.join(__dirname, 'setup-core.sh');

    // Graficzny prompt o hasło roota (Polkit / gksu / kdesudo)
    sudo.exec(`bash "${scriptPath}"`, options, (error, stdout, stderr) => {
        if (error) {
            win.webContents.send('install-done', false, error.message);
            return;
        }

        win.webContents.send('install-progress', 'Tworzenie skrótu w systemie...', 80);

        // Dokończenie konfiguracji jako zwykły użytkownik (skrót .desktop)
        const appDir = __dirname;
        const desktopFile = `[Desktop Entry]
        Type=Application
        Name=Pitaya Cam
        Comment=Virtual Camera Hub (Android & iPhone)
        Exec=npm start --prefix ${appDir}
        Icon=${appDir}/assets/icon.svg
        Terminal=false
        Categories=AudioVideo;Video;
        `;

        exec(`mkdir -p ~/.local/share/applications && rm -f ~/.local/share/applications/mangocam.desktop && echo "${desktopFile}" > ~/.local/share/applications/pitayacam.desktop && update-desktop-database ~/.local/share/applications`, () => {
            win.webContents.send('install-done', true);
        });
    });
});

ipcMain.on('launch-app', () => {
    spawn('npm', ['start'], { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();
    app.quit();
});
