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

![Übergeordneter Knoten und Unterknoten](/help/diagrams/scene-hierarchy.svg)

_Die Unterknoten eines Knotens folgen seiner Transformation: Bewegst oder drehst du den übergeordneten Knoten, kommt alles darunter mit._

Knoten sind in einem Baum angeordnet. Ein Knoten kann Unterknoten haben, und
diese folgen ihrem übergeordneten Knoten: Bewegst oder drehst du den
übergeordneten Knoten, kommt alles darunter mit. So befestigst du eine Requisite
an einer Hand oder bewegst ein ganzes Set auf einmal.

Du kannst die Szenenliste per Ziehen umordnen. Lässt du einen Knoten **auf**
einem anderen Knoten (oder irgendwo zwischen dessen Unterknoten) fallen, wird er
zu dessen Unterknoten; lässt du ihn **zwischen** zwei Zeilen — oder ganz oben
oder unten in einer Ebene — fallen, wird er dort als Geschwisterknoten platziert.
Eine blaue Linie zeigt die Zielposition; eine hervorgehobene Zeile bedeutet, dass
er darin verschachtelt wird. Du kannst einen Knoten auf eine **andere Szene** (ihre
Zeile oder ihre Knotenliste) ziehen, um ihn dorthin zu verschieben. Halte beim
Loslassen **Strg** (**⌘** auf dem Mac) gedrückt, um statt des Verschiebens eine
**Kopie** abzulegen — die Kopie umfasst den gesamten Unterbaum des Knotens, seine
Behaviors und seine Logik.

Rechtsklicke eine **Szenen**-Zeile, um auf der obersten Ebene der Szene einen
Knoten hinzuzufügen oder einen kopierten Knoten bzw. Logikgraphen einzufügen.

### An einen Knochen anheften {#attach-bone}

Du kannst eine Requisite auch direkt im 3D-Ansichtsfenster an einen bestimmten
Knochen eines Avatars binden. Aktiviere den **Anheften-Modus** über die
Knochen-Schaltfläche in der Werkzeugleiste unten links (oder halte einfach die
**Umschalttaste** beim Ziehen), bewege dann ein Objekt mit dem Verschieben-Gizmo
und lasse es über einem Modell los. Das Objekt bindet sich an den Knochen, der die
Oberfläche steuert, auf der es abgelegt wurde – lege es auf die Hand, folgt es der
Hand; lege es auf den Kopf, folgt es dem Kopf. Seine Weltposition und -drehung
bleiben erhalten, und ab diesem Punkt wird seine Transformation relativ zum Raum
dieses Knochens gemessen. So bekommst du am schnellsten ein Schwert in die Hand
oder einen Hut auf den Kopf, ohne den Baum zu durchsuchen.

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
