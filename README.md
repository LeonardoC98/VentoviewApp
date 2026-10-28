# Ventoview – Desktop-App (VentoviewApp)

Ein Baukasten für Stream-Overlays. Die **Desktop-App** liest Live-Daten auf dem eigenen PC aus, zum Beispiel Rang und LP aus dem League-Client. Auf der **Webseite** baut man daraus im Editor ein eigenes Overlay aus Texten, Bildern, Videos und Flächen. Dort gibt es Variablen wie `{divsoloduo}`, Bedingungen und eine Timeline mit Animationen. Den fertigen Link fügt man in OBS als Browser-Quelle ein.

```
League-Client ──► Ventoview-App (Tray, Autostart) ──► 127.0.0.1:47800
                     │  Module, Designs, eigene Medien        ▲
                     │                                        │ WebSocket / HTTP
                     ▼                                        │
              Modul-Pakete  ◄── Webseite (Server) ──►  Editor & OBS-Overlay laufen im Browser
```

Spieldaten, Designs und eigene Bilder bleiben auf dem PC. Die Webseite liefert nur die Seiten aus. Die Daten holt sich der Browser direkt von der App.

Dieses Repo enthält die **Desktop-App** (Electron, Tray, Autostart, Installer, Updates). Webseite, Editor und Module liegen im Repo **VentoviewWeb**. Module lädt die App von dort herunter.

## Ordner

```
main.js, preload.js      Fenster, Tray, Autostart, Verbindung zur Oberfläche
core/bridge.js           lokaler Dienst auf 127.0.0.1 (die Schnittstelle zur Webseite)
core/modules.js          Module laden, installieren, freischalten, Einstellungen, Aktionen
core/account.js          Verbindung zum Ventoview-Konto (Lizenzschein)
core/twitch.js           Twitch-Verbindung für Module (Gerätecode)
core/designs.js          Designs und eigene Bilder, Videos und Töne speichern
core/keywords.js         eigene Keywords (Text, Datei, Befehl, Webadresse)
ui/                      Oberfläche der App
```

### Lokaler Dienst (`core/bridge.js`) auf `127.0.0.1:47800`

- `ws://…/ws` für Live-Daten (`subscribe`), Design-Änderungen (`watch`) und Anfragen (`designs.*`, `assets.*`, `license.*`, `module.action`, `module.settings`)
- `POST /assets` lädt ein Bild, Video oder einen Ton hoch, `GET /assets/<datei>` liefert es aus
- `GET /files/<modul>/<datei>` liefert Bilder aus, die ein Modul selbst erzeugt, z. B. Album-Cover

## Entwickeln

```bash
npm install
npm start            # die Webseite (VentoviewWeb) sollte lokal auf http://localhost:8080 laufen
```

Unter **Einstellungen** die App mit dem Konto verbinden: auf der Kontoseite „Diesen PC verbinden“ klicken oder einen Code eingeben. Danach Module installieren.

## Installer bauen

```bash
npm run dist         # → dist/Ventoview-Setup-<version>.exe
```

Der Installer ist nicht signiert. Windows zeigt deshalb beim ersten Start eine SmartScreen-Warnung („Weitere Informationen“ → „Trotzdem ausführen“). Mit einem Code-Signing-Zertifikat fällt die Warnung weg.

## Updates über GitHub veröffentlichen

Die installierte App prüft beim Start und alle 4 Stunden, ob es auf GitHub eine neuere Version gibt. Sie lädt die neue Version im Hintergrund, nach Möglichkeit nur den geänderten Teil, und prüft sie per SHA-512. Installiert wird beim Beenden oder per Klick auf **Update installieren**.

**Einmalig einrichten**

1. Das Repository für die Releases muss **öffentlich** sein (Eintrag `build.publish` in `package.json`). Bei einem privaten Repo könnten die Apps die Updates nicht abrufen. Wenn der Code privat bleiben soll, nimm ein eigenes öffentliches Repo nur für die Releases.
2. In `package.json` unter `build.publish` GitHub-Name (`owner`) und Repo (`repo`) eintragen.
3. Einen Token anlegen: GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained* mit Zugriff auf das Repo und **Contents: Read and write**. Den Token nie in eine Datei schreiben.

**Neue Version veröffentlichen**

```powershell
npm version patch            # 1.2.0 → 1.2.1   (minor = neue Funktionen, major = große Umbauten)
$env:GH_TOKEN = "github_pat_…"   # gilt nur in diesem Terminal
npm run release
```

`npm run release` baut den Installer und lädt ihn zusammen mit `latest.yml` und der Blockmap als **Entwurf** in die GitHub-Releases. Auf GitHub unter *Releases* den Entwurf öffnen, beschreiben, was neu ist, und **Publish release** klicken. Ab dann finden alle installierten Apps das Update.

Danach im Repo **VentoviewWeb** in `app.json` die neue Version eintragen. Die Webseite zeigt sie an und verlinkt den Download.


## Konto und Twitch

- **Konto:** Ohne verbundenes Ventoview-Konto laufen keine Module. Der Lizenzschein ist signiert, wird alle 6 Stunden erneuert und gilt offline bis zu 7 Tage.
- **Twitch:** „Mit Twitch verbinden“ zeigt einen Code für twitch.tv/activate (öffentliche Twitch-App, ohne Secret). Die Tokens bleiben verschlüsselt auf dem PC. Module nutzen sie über `ctx.twitch` (`user`, `scopes`, `token()`). Seit 1.6.0 fragt die App zusätzlich Chat schreiben und Whispers an (Chat-Bot). Ältere Verbindungen einmal trennen und neu verbinden.
- **Werte anderer Module:** `ctx.values()` liefert die aktuellen Werte aller Module und eigenen Keywords (seit 1.6.0), z. B. für `!rank` mit `{divsoloduo}` im Chat-Bot.
- **Umstieg von StreamHub:** Beim ersten Start übernimmt Ventoview Einstellungen, Konto, Designs, Medien und Module aus dem alten StreamHub-Ordner.

## Eigene Daten einbinden

Alles, was ein Modul nicht mitbringt, legst du in der App unter **Keywords** selbst an. Jedes eigene Keyword hat eine **Quelle**:

| Quelle | Wofür | Beispiel |
|---|---|---|
| **Text** | feste Angaben | `{streamer}` = „Vento“ |
| **Datei** | Programme, die Infos in eine Textdatei schreiben (Musik-Player, Bots, Spenden-Tools) | `C:\Stream\song.txt`, alle 2 s |
| **Befehl** | alles, was PowerShell auslesen kann | `(Test-Connection 1.1.1.1 -Count 1).ResponseTime` → Ping |
| **Webadresse** | Programme mit Webserver oder APIs, optional ein Feld per JSON-Pfad | `http://localhost:8085/data.json` + `**[Text~Tctl].Value` |

Dynamische Quellen werden im eingestellten Abstand neu gelesen. Die App zeigt neben jedem Keyword den aktuellen Wert oder den Fehler. Im Editor stehen eigene Keywords unter **Variablen → Ventoview**.

**Mehrere Werte aus einem Befehl:** Gibt ein Befehl (oder eine Datei oder Webadresse ohne JSON-Pfad) ein JSON-Objekt aus, wird jedes Feld zu einer eigenen Variable:

```powershell
# Keyword „pc“, Quelle Befehl
$os = Get-CimInstance Win32_OperatingSystem
@{ cpu = (Get-CimInstance Win32_Processor).Name.Trim(); system = $os.Caption } | ConvertTo-Json -Compress
```

Daraus werden `{pc_cpu}` und `{pc_system}`.

**JSON-Pfad:** `data.title` (Feld in Feld), `items[0].name` (Listenelement), `**[Text=GPU Core].Value` (sucht im ganzen Baum ein Objekt, dessen Feld `Text` genau so heißt), `**[Text~Tctl].Value` (… das Wort enthält).

### Beispiel: CPU-Temperatur

Windows liefert die CPU-Temperatur meist nicht selbst. So geht es trotzdem:

1. Das kostenlose **LibreHardwareMonitor** installieren und starten, am besten als Administrator.
2. Dort unter **Options → Remote Web Server → Run** den Webserver einschalten (Port 8085).
3. In Ventoview unter **Keywords** das Beispiel **„CPU-Temperatur“** übernehmen und speichern. Es liest `http://localhost:8085/data.json` mit dem Pfad `**[Text~Tctl].Value` (AMD). Bei Intel heißt der Pfad `**[Text~CPU Package].Value`.
4. Im Editor `{cputemp}` in einen Text schreiben. Für eine Warnung legst du eine zweite, rote Textebene mit der Bedingung **„cputemp größer als 80“** an. Einheiten wie „52,8 °C“ stören die Zahlenvergleiche nicht.

### Gut zu wissen

- **Befehle zuerst in PowerShell testen.** Was dort als Text herauskommt, wird der Wert (höchstens 500 Zeichen).
- **Abstände sinnvoll wählen:** Dateien ab 1 s, Befehle ab 2 s, Webadressen ab 5 s. Langsame Befehle lieber alle 30–300 s.
- **Heißt ein eigenes Keyword wie eines aus einem Modul**, hat im Overlay das Modul Vorrang. Wähle daher eigene Namen, z. B. `grafikkarte` statt `gpu`.
- **Sicherheit:** Befehle laufen mit deinen Rechten auf deinem PC. Trag nur Befehle ein, die du verstehst, niemals welche aus dem Chat. Eigene Keywords lassen sich nur in der App ändern, die Webseite kann sie nicht anlegen oder ausführen.
- **Wenn es aufwendiger wird** (Anmeldung, eigene Bilder, viele zusammengehörige Werte), lohnt sich ein eigenes Modul, siehe unten.


## Sicherheit

- Der lokale Dienst lauscht nur auf `127.0.0.1` und ist aus dem Netzwerk nicht erreichbar.
- WebSocket-Verbindungen und Uploads werden nur von der eingestellten Webseite angenommen (Origin-Prüfung). Andere Webseiten, die im Browser offen sind, kommen nicht an die Daten.
- Die Host-Prüfung schützt vor DNS-Rebinding.
- Eigene Medien bekommen zufällige, nicht erratbare Dateinamen. Es sind nur Bild- und Videoformate erlaubt.
- Modul-Pakete werden vor der Installation per SHA-256 geprüft.
- `/files/` liefert nur Bilddateien aus dem öffentlichen Ordner installierter Module aus.
- In der gepackten App sind Electron-Fuses gesetzt: kein Node-Modus, kein `--inspect`, nur Code aus dem signierten asar-Archiv.

*Ventoview ist nicht mit Riot Games verbunden. League of Legends ist eine Marke von Riot Games, Inc.*

## Module, Erweiterungen, Teilen (ab 1.7.0)

- **Module** werden nicht mehr installiert: Alles, was das Konto freischaltet, lädt die App selbst herunter. Man schaltet Module nur aktiv oder inaktiv (`config.json` → `inactive`).
- **Erweiterungen** (`.vvext`, von der Webseite signiert) erweitern die App, z. B. um globale Tastenkürzel. Zu finden unter Einstellungen → Erweiterungen. Braucht ein Modul eine, führt ein Assistent durch Download und Einsetzen.
- **Teilen:** Vorlagen samt eigenen Medien und auf Wunsch den Home-Einstellungen als Ordner nach `Dokumente\Ventoview\Teilen` exportieren. Zum Importieren den Ordner dort ablegen.
