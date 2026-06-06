# Szene {#scene}

Die **Szene** ist deine 3D-Welt, die auf dem **Stage**-Tab angezeigt wird. Alles,
was dein Publikum sieht, befindet sich hier: dein [Avatar](topic:avatar), die
Kamera, die ihn einrahmt, Lichter sowie Requisiten oder Effekte.

## Knoten {#nodes}

Jedes Element einer Szene ist ein **Knoten**. Gängige Arten sind:

- **Avatar** — eine VRM-Figur.
- **Kamera** — legt den gestreamten Blickwinkel fest.
- **Licht** — beleuchtet die Szene.
- **Gruppe** — ein leerer Knoten, um mehrere Elemente zu ordnen oder gemeinsam zu
  bewegen.
- **Requisiten** — Bilder, Video, Text und Partikeleffekte.

Wähle einen Knoten aus, um ihn im **Eigenschaften**-Bereich rechts zu bearbeiten.

## Hierarchie {#hierarchy}

Knoten sind in einem Baum angeordnet. Ein Knoten kann Unterknoten haben, und
diese folgen ihrem übergeordneten Knoten: Bewegst oder drehst du den
übergeordneten Knoten, kommt alles darunter mit. So befestigst du eine Requisite
an einer Hand oder bewegst ein ganzes Set auf einmal.

Du kannst Knoten in der Szenenliste ziehen, um sie neu zuzuordnen.

## Kameras {#cameras}

Die Kamera bestimmt, was deine Zuschauer sehen. Du kannst sie positionieren, auf
deinen Avatar ausrichten und mehrere für verschiedene Einstellungen erstellen.
Jede Kamera kann zudem eigene visuelle Effekte haben, etwa Bloom oder
Tiefenunschärfe.

## Lichter {#lights}

Lichter bestimmen die Stimmung. Realistische
[Materialien](topic:avatar#materials) reagieren auf sie, während Materialien im
Toon-Stil sie meist ignorieren. Probiere ein Hauptlicht plus ein weicheres
Fülllicht für einen schmeichelhaften Look.

## Compose {#compose}

Die **Compose**-Ansicht platziert 2D-Ebenen — Overlays, Bilder, Browserquellen,
deinen Webcam-Rahmen — vor oder hinter dem 3D-Bild. Hier baust du das endgültige
Layout für deinen Stream auf, unabhängig von der 3D-Szene selbst.
