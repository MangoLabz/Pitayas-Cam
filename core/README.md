# Pitaya Core

Wspólny rdzeń, na którym działają wszystkie aplikacje Pitayas (Bot Builder, Cam, Convert, Deck, Book).
Aplikacje Electron używają wersji JS, aplikacje w Pythonie (Pitaya Book) — `python/pitaya_core.py`.
Obie wersje trzymają się tej samej umowy (pliki + protokół poniżej), więc przyszły **Pitaya Hub** zobaczy je jednakowo.

To jest **jedyne źródło** kodu Core. Każda aplikacja ma jego kopię w folderze `core/`,
dzięki czemu repozytorium aplikacji da się sklonować i zbudować samodzielnie.
Po zmianie czegokolwiek tutaj uruchom:

```bash
../ADMIN/sync-core.sh
```

Skrypt skopiuje Core do wszystkich aplikacji (Electron → `core/*.js`, Python → `core/pitaya_core.py`). Kompilacja przez Pitayas Admin robi to sama.

## Co daje Core

| Moduł            | Do czego                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `index.js`       | folder danych, migracja starych danych, ustawienia, logi, jedna instancja |
| `registry.js`    | rejestr aplikacji, stan „działa”, uruchamianie innych aplikacji (bez Electrona) |
| `control.js`     | kanał sterowania: lokalne gniazdo z poleceniami JSON                     |
| `python/`        | to samo dla aplikacji w Pythonie                                          |
| `cli.js`         | podgląd z terminala: `node cli.js list / send <id> <cmd> / launch <id>`   |
| `updater.js`     | aktualizacje z GitHuba (git pull / nowy AppImage / strona wydania)        |
| `bridge.js`      | `window.pitayaBridge` dla okna aplikacji                                  |
| `ui/`            | wspólny wygląd (`pitaya-theme.css`) i obsługa okna (`pitaya-ui.js`)       |

## Folder danych

```
~/.config/Pitayas/                 Windows: %APPDATA%\Pitayas  (zmiana: zmienna PITAYAS_HOME)
  apps/<id>.json                   wpis aplikacji (schema 2): nazwa, wersja, opis, jak uruchomić, ikona, folder danych
  run/<id>.json                    tylko gdy działa: pid, start, adres gniazda, status aplikacji
  run/<id>.sock                    gniazdo sterowania (Windows: \\.\pipe\pitayas-<id>)
  core.json                        stary zbiorczy spis (zostaje dla zgodności)
  Bot-Builder/  Cam/  Convert/  Deck/  Book/
    settings.json                  ustawienia aplikacji
    data/                          dane aplikacji
    logs/app.log                   dziennik (rotacja po 1 MB)
    cache/                         pamięć podręczna Electrona
    icon.png                       ikona aplikacji (dla huba)
```

## Umowa dla huba

**Rejestr** — każda aplikacja przy starcie zapisuje `apps/<id>.json`:

```json
{ "schema": 2, "id": "deck", "name": "Pitaya Deck", "folder": "Deck", "kind": "electron",
  "description": "…", "version": "0.2.1-beta", "coreVersion": "0.2.0",
  "launch": { "command": "/…/PitayaDeck.AppImage", "args": [], "cwd": "…" },
  "icon": "~/.config/Pitayas/Deck/icon.png", "repo": "MangoLabz/Pitayas-Deck",
  "dataDir": "~/.config/Pitayas/Deck", "lastRun": "…" }
```

**Działa / nie działa** — `run/<id>.json` istnieje tylko w czasie działania (`pid`, `startedAt`, `control`, `status`).
Po awarii plik może zostać, dlatego zawsze sprawdzaj, czy `pid` żyje (`registry.listApps()` robi to sam).

**Sterowanie** — gniazdo `run/<id>.sock`, jedna linia JSON na wiadomość:

```
→ {"id":1,"cmd":"status","args":{}}
← {"id":1,"ok":true,"result":{"port":8191,"devicesOnline":1}}
```

| Polecenie | Co robi                                                        |
| --------- | -------------------------------------------------------------- |
| `ping`    | czy żyje                                                       |
| `info`    | nazwa, wersja, wersja Core, pid, folder danych, lista poleceń  |
| `status`  | to, co aplikacja opublikowała przez `core.setStatus({...})`    |
| `show`    | pokaż okno (to samo co ponowne uruchomienie)                   |
| `quit`    | zamknij porządnie (wywołuje sprzątanie aplikacji)              |

Aplikacja dopisuje własne polecenia: `core.control.handle('nazwa', async (args) => wynik)`.
Inna aplikacja (albo hub) korzysta z nich przez `core.apps()`, `core.launch(id)`, `core.send(id, cmd, args)`.

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
core.setStatus({ converting: 2 });                       // widoczne dla huba
core.control.handle('convert-file', (args) => queue(args.path));
core.send('deck', 'status').then(console.log);           // rozmowa z inną aplikacją
```

Python (Pitaya Book):

```python
from core import pitaya_core
core = pitaya_core.create(id="book", folder="Book", name="Pitaya Book", version="0.1.0", app_dir=APP_DIR,
                          launch={"command": os.path.join(APP_DIR, "run.sh")})
if not core.single_instance(on_show=open_browser): raise SystemExit(0)
core.start()
core.set_status({"url": "http://localhost:5000"})
```

```js
// preload.js
contextBridge.exposeInMainWorld('pitayaBridge', require('./core/bridge').makeBridge(ipcRenderer));
```

```html
<link rel="stylesheet" href="core/ui/pitaya-theme.css">
<script src="core/ui/pitaya-ui.js"></script>
```
