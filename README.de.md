# vspark

[English](README.md) | **Deutsch**

Echtzeit-3D-Avatar-Streaming-System. Motion-Capture-Daten (VMC über UDP, MediaPipe aus dem Browser, mikrofonbasiertes Lipsync) fließen in serverseitige reaktive Signalgraphen und werden mit ~60 Hz an einen Three.js/VRM-Viewport gesendet.

## Funktionen

### Motion-Capture-Eingänge
- **VMC-Protokoll** — UDP-OSC-Empfänger, kompatibel mit VMC-, RhyLive- und ARKit-Blendshape-Streams.
- **MediaPipe Holistic** — browserseitige Kameraerfassung in einem Web Worker (320×240, 10 FPS) für Gesichts-, Körper- und Hand-Landmarks.
- **Mikrofon-Lipsync** — In-Browser-MFCC-Vokalklassifikation mit komponentenspezifischer Kalibrierung, treibt `Fcl_MTH_*`-Visem-Gewichte sowie Kieferöffnung aus dem RMS-Pegel.

### Avatar & Szene
- **VRM-Avatare** — Unterstützung für VRM 0.x und 1.x. Sparsames Streaming von Knochenrotationen, Blendshape-Ausdrücke, Slots für Knochenanbindungen.
- **Szenengraph** — Hierarchie Projekt → Szene → Knoten (VRM, Kamera, Licht, Gruppe) mit Transform-Vererbung, persistiert in SQLite.
- **Komponenten** — Verhaltenstreiber, die an Knoten angehängt werden: VMC-Empfänger, Atmung, Lipsync, MediaPipe-Tracker. Jede Komponente wird durch ihre eigene Signalgraph-Instanz gestützt.
- **Animations-Retargeting** — FBX/BVH-Clip-Wiedergabe, retargetet auf VRM-Rigs (World-Space-Delta-Retargeting; A-Pose-Unterstützung).

### Signalgraph
- **Reaktive Engine** — hybride Push- (Events) und Pull- (Werte) Ausführung mit typisierten Ports, Wert-Caching und Zykluserkennung.
- **32 eingebaute Knotenarten**, darunter OSC-Quelle, Bone-Mapper, Körper-/Arm-Kalibrierung, IK-Ziele, MediaPipe-Konverter, Blendshape-Mux und Broadcast-Senken.
- **Visueller Graph-Editor** im Frontend zum Inspizieren und Verdrahten von Komponenten.

### Viewport
- React-Three-Fiber-Canvas mit Post-Processing-Pipeline (18 Kameraeffektarten).
- GPU-instanziertes Partikelsystem und Billboard-Knoten.
- Analytischer Zwei-Knochen-IK-Solver für die Arme im MediaPipe-Modus.

### Werkzeuge
- **Asset-Manager** — VRMs, FBX/BVH-Clips und andere Assets pro Projekt hochladen und organisieren.
- **Auto-Update** — Prüfung des GitHub-Releases-Kanals, Download und Anwendung (Stable / Pre-Release).
- **Plattformübergreifende Releases** — gebündelte Node.js-20-Laufzeit, win-x64- und linux-x64-Zips, gebaut von CI.

## Architektur-Überblick

```
packages/
  backend/    Node.js/Express — Signalgraph-Engine, SQLite-Persistenz, Motion-Capture-Manager
  frontend/   React + React Three Fiber — 3D-Viewport, Knotengraph-Editor, Zustand-State
  shared/     TypeScript-Typen, Zod-Schemas, Signalgraph-Typdefinitionen
```

Siehe [dev-notes/ARCHITECTURE.md](dev-notes/ARCHITECTURE.md) für Modulstatus, Datenflüsse und Verweise auf die Modul-Dokumentation.

## Installation

### Vorgefertigtes Release (empfohlen)

Vorgefertigte Zips für Windows und Linux werden auf der [GitHub-Releases](../../releases)-Seite veröffentlicht. Jedes Bundle enthält eine Node.js-20-Laufzeit, das Backend-Bundle, die Frontend-Assets sowie ein Start-/Updater-Skript — keine Node- oder pnpm-Installation erforderlich.

1. Lade `vspark-win-x64.zip` oder `vspark-linux-x64.zip` aus dem letzten Release herunter.
2. Entpacke das Archiv an einem beliebigen Ort; du erhältst einen Ordner `vspark/`.
3. Starte das Programm:
   - Windows: Doppelklick auf `start.bat`
   - Linux: `./start.sh`
4. Öffne die in der Konsole ausgegebene Editor-URL (standardmäßig `http://localhost:3001`).

In-App-Updates: Die TopBar des Editors prüft GitHub-Releases auf dem gewählten Kanal (Stable / Pre-Release) und ruft den mitgelieferten Updater auf, um Downloads anzuwenden.

### Aus dem Quellcode

Diesen Weg nimmst du, wenn du an vspark entwickeln oder einen unveröffentlichten Branch ausführen willst.

#### Voraussetzungen
- **Node.js** 20 LTS oder neuer
- **pnpm** 9+ (`npm install -g pnpm`)
- Ein moderner Browser mit WebGL2 + getUserMedia (für Editor sowie Lipsync-/MediaPipe-Eingänge)

Die SQLite-Schicht verwendet `node-sqlite3-wasm` — keine nativen Build-Tools oder Python erforderlich.

#### Clonen

```bash
git clone https://github.com/<your-org>/vspark.git
cd vspark
pnpm install
```

### Entwicklung

Beide Pakete parallel starten:

```bash
pnpm dev
```

Oder einzeln:

```bash
pnpm dev:backend   # Express + WS unter http://localhost:3001
pnpm dev:frontend  # Vite-Dev-Server unter http://localhost:5173
```

Öffne das Frontend im Browser. Das Backend öffnet seinen UDP-OSC-Socket auf dem Port, der pro VMC-Komponente konfiguriert ist.

### Produktions-Build

```bash
pnpm build         # Typprüfung + Backend kompilieren, Frontend-Bundle bauen
pnpm bundle        # Eigenständiges Backend-Bundle erzeugen (esbuild)
```

Das gepackte Release (mit gebündelter Node-Laufzeit und Updater-Skripten) wird vom GitHub-Actions-Workflow in `.github/workflows/release.yml` erzeugt.

### Qualitätsprüfungen

```bash
pnpm lint     # TypeScript-Typprüfung über alle Pakete
pnpm format   # Prettier-Formatierung
```

Es ist keine Laufzeit-Testsuite konfiguriert; `pnpm lint` ist die primäre Korrektheitsprüfung.

## Konfiguration

- **Datenbank** — SQLite-Datei wird beim ersten Start angelegt; Migrationen liegen unter [packages/backend/src/db/migrations/](packages/backend/src/db/migrations/).
- **Uploads** — Assets werden im Arbeitsverzeichnis unter `uploads/` gespeichert.
- **Update-Kanal** — In der TopBar des Editors wählbar; persistiert in `config.json`.

## Repository-Struktur

| Pfad | Zweck |
|------|-------|
| `packages/backend/` | HTTP- + WebSocket-Server, Signalgraph-Laufzeit, Motion-Capture-Manager, DB |
| `packages/frontend/` | Editor-UI, 3D-Viewport, Signalgraph-Canvas |
| `packages/shared/` | Domänentypen, Zod-Schemas, Signalgraph-Typsystem |
| `dev-notes/` | Architektur- und Modul-Dokumentation für Entwickler |
| `uploads/` | Asset-Speicher (zur Laufzeit erstellt) |
