# Pitaya Core

Wspólny rdzeń, na którym działają wszystkie aplikacje Pitayas (Bot Builder, Cam, Convert).

To jest **jedyne źródło** kodu Core. Każda aplikacja ma jego kopię w folderze `core/`,
dzięki czemu repozytorium aplikacji da się sklonować i zbudować samodzielnie.
Po zmianie czegokolwiek tutaj uruchom:

```bash
../ADMIN/sync-core.sh
```

Skrypt skopiuje Core do wszystkich aplikacji. Kompilacja przez Pitayas Admin robi to sama.

## Co daje Core

| Moduł            | Do czego                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `index.js`       | folder danych, migracja starych danych, ustawienia, logi, jedna instancja |
| `updater.js`     | aktualizacje z GitHuba (git pull / nowy AppImage / strona wydania)        |
| `bridge.js`      | `window.pitayaBridge` dla okna aplikacji                                  |
| `ui/`            | wspólny wygląd (`pitaya-theme.css`) i obsługa okna (`pitaya-ui.js`)       |

## Folder danych

```
~/.config/Pitayas/                 Windows: %APPDATA%\Pitayas
  core.json                        zainstalowane aplikacje, wersje, ostatnie uruchomienie
  Bot-Builder/  Cam/  Convert/
    settings.json                  ustawienia aplikacji
    data/                          dane aplikacji
    logs/app.log                   dziennik (rotacja po 1 MB)
    cache/                         pamięć podręczna Electrona
```

Przy pierwszym uruchomieniu Core kopiuje dane ze starych folderów (`mangocam`, `mango-bot-builder`…).
Stare foldery zostają nietknięte — można je usunąć ręcznie, gdy wszystko działa.

## Użycie

```js
// main.js — przed app.whenReady()
const core = require('./core').create({
    id: 'convert', folder: 'Convert', name: 'Pitaya Convert',
    repo: 'MangoLabz/Pitayas-Convert', appDir: __dirname,
    defaults: { encoder: 'auto' },
    legacy: [{ from: 'mango-convert/settings.json', to: 'settings.json' }],
});
core.singleInstance(() => showWindow());
core.registerIpc();
core.log.info('Gotowe');
core.settings.set('encoder', 'nvenc');
```

```js
// preload.js
contextBridge.exposeInMainWorld('pitayaBridge', require('./core/bridge').makeBridge(ipcRenderer));
```

```html
<link rel="stylesheet" href="core/ui/pitaya-theme.css">
<script src="core/ui/pitaya-ui.js"></script>
```
