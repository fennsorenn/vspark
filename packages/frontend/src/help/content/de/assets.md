# Assets {#assets}

Der **Assets**-Bereich am unteren Rand des Editors ist dein Ausgangspunkt,
um eigene Dateien in vspark einzubinden. Einmal hochgeladen, überall nutzbar:
Dieselbe Datei kann mehreren Objekten in deiner Szene zugewiesen werden,
ohne erneut hochgeladen zu werden.

## Was sind Assets? {#what}

Assets sind Dateien, die du einem Projekt hinzufügst, damit vspark sie
verwenden kann. Sie bleiben im Projekt gespeichert und stehen dir in allen
Sitzungen zur Verfügung. Folgende Dateitypen werden unterstützt:

- **3D-Modelle / VRM** — dein Avatar oder andere 3D-Objekte (`.vrm`, `.glb`, `.gltf`).
- **Animationen** — Bewegungsdaten, die auf einen Avatar oder ein Modell angewendet werden (`.fbx`, `.bvh`).
- **Bilder** — Standbilder als Texturen, Overlays oder Szenenhintergrund (`.png`, `.jpg`, `.webp`, `.gif` und mehr).
- **Videos** — Videoclips in der Szene oder in der Compose-Ansicht (`.mp4`, `.webm`, `.mov` und mehr).
- **Audio** — Sounddateien, die als Teil der Szene abgespielt werden (`.mp3`, `.wav`, `.ogg` und mehr).

## Dateien hochladen {#uploading}

Es gibt zwei Wege, Dateien in den Assets-Bereich zu laden:

1. **Drag-and-Drop** — ziehe eine oder mehrere Dateien aus deinem
   Dateimanager und lasse sie irgendwo auf dem Assets-Bereich fallen. vspark
   erkennt den Dateityp automatisch und wechselt nach dem Hochladen zum
   richtigen Reiter.
2. **Upload-Schaltfläche** — wechsle zum gewünschten Reiter (z. B.
   **Modelle**) und klicke auf die Upload-Schaltfläche oben rechts im Bereich.
   Es öffnet sich ein Datei-Dialog, in dem du die Datei auswählen kannst.

Während des Hochladens wird ein Fortschrittsindikator angezeigt. Falls eine
Datei nicht hochgeladen werden konnte, erscheint eine Meldung mit dem Namen
der betroffenen Datei.

## Asset-Kategorien {#kinds}

Der Bereich ist in Reiter unterteilt, einen pro Dateityp:

| Reiter | Inhalt | Verwendung |
|--------|--------|-----------|
| **Modelle** | `.vrm`, `.glb`, `.gltf` | Dein Avatar und andere 3D-Objekte |
| **Animationen** | `.fbx`, `.bvh` | Bewegungsclips für einen Avatar |
| **Bilder** | `.png`, `.jpg`, `.webp`, `.gif`, … | Overlays, Texturen, Szenenhintergrund |
| **Videos** | `.mp4`, `.webm`, `.mov`, … | Video-Objekte oder Compose-Ebenen |
| **Audio** | `.mp3`, `.wav`, `.ogg`, … | Hintergrundmusik oder Soundeffekte |

Mit der Suchleiste rechts oben kannst du innerhalb eines Reiters suchen —
praktisch, wenn du viele Dateien verwaltest.

## Ein Asset in der Szene verwenden {#using}

Sobald eine Datei hochgeladen ist, kannst du sie auf verschiedene Arten
nutzen:

- **In die Szene ziehen** — ziehe eine Asset-Karte aus dem Bereich auf den
  Szenenbaum links oder in das 3D-Ansichtsfenster. Ein neues Objekt wird
  automatisch für dich erstellt.
- **Zur Szene hinzufügen / Als Billboard / Als Video hinzufügen** — klicke
  die Schaltfläche auf einer Asset-Karte, um sie sofort als passendes Objekt
  in die aktuelle Szene einzufügen.
- **Auf ein ausgewähltes Objekt anwenden** — wähle zunächst ein Objekt in der
  Szene aus, und klicke dann auf **Auf [Name] anwenden**, um dessen Modell,
  Textur oder Animation auszutauschen.
- **Als Hintergrund festlegen** — wähle eine Kamera aus und klicke bei einem
  Bild auf **Als Hintergrund**, um es als Hintergrund dieser Kamera zu
  verwenden.

Wenn eine Schaltfläche auf einer Karte nicht erscheint, überprüfe, ob das
richtige Objekt in der Szene ausgewählt ist. Zum Beispiel wird die
**Anwenden**-Schaltfläche für eine Animation nur angezeigt, wenn ein Avatar
oder ein Modell ausgewählt ist.
