# Camera {#camera}

Die Kamera-Eigenschaften steuern, was ein Kamera-Knoten sieht, wie er die Szene auf den Bildschirm projiziert und wie stark die Umgebungsbeleuchtung in der Ausgabe gewichtet wird.

## Field of view (FOV) {#fov}

Das Sichtfeld ist der Winkel des Kegels, den die Kamera erfasst, gemessen in Grad über die vertikale Ausdehnung des Bildes. Es gilt nur, wenn die Kamera auf **Perspective** eingestellt ist.

- **Niedrige Werte (z. B. 20–30°)** zoomen heran und komprimieren die Tiefe — das Gesicht des Avatars wirkt flacher, und weiter entfernte Merkmale erscheinen näher beieinander. Das ist der Tele- oder Porträteffekt.
- **Hohe Werte (z. B. 70–90°)** zeigen einen größeren Ausschnitt der Szene, übertreiben jedoch die Perspektive: Objekte nahe der Kamera erscheinen groß, weiter entfernte schrumpfen schnell.
- **Typischer Streaming-Bereich:** 40–60° ergeben ein natürliches Bild. Standardwert ist 50°.

Eine Änderung des FOV bewegt die Kamera nicht; kombiniere ihn mit dem Transform-Position-Wert, um die Einstellung neu zu gestalten.

## Projection {#projection}

Projection bestimmt das geometrische Modell, das verwendet wird, um den 3D-Raum auf das flache Bild zu übertragen.

- **Perspective** — weiter entfernte Objekte erscheinen kleiner, wie es dem menschlichen Auge entspricht. Geeignet für die meisten Avatar- und Szenenaufnahmen. Standard.
- **Orthographic** — Objekte erscheinen unabhängig von ihrer Entfernung zur Kamera gleich groß; es gibt keinen Fluchtpunkt. Geeignet für UI-artige Overlays, flache Vogelperspektiven oder Seitenansichten sowie für Aufnahmen ohne Perspektivverzerrung.

Bei Orthographic wird das FOV-Feld durch ein **Size**-Feld ersetzt (die halbe Höhe der Ansicht in Welteinheiten, Standard 2). Einen größeren Wert einzugeben zoomt heraus; einen kleineren herein.

## Near & far clipping {#clipping}

Near und Far sind die zwei Tiefenebenen, die begrenzen, was die Kamera rendert.

- **Near** — alles, was näher als dieser Abstand (in Szeneneinheiten) zur Kamera liegt, wird nicht gezeichnet. Standard: 0,1. Ein zu niedriger Wert kann Flimmern (Z-Kämpfen) auf überlappenden Flächen verursachen; ein zu hoher Wert schneidet die Vorderseite naher Objekte ab.
- **Far** — alles, was weiter als dieser Abstand entfernt ist, wird nicht gezeichnet. Standard: 1000. Ein kleinerer Wert kann die Tiefenpuffer-Präzision verbessern, wenn Z-Kämpfen bei weit entfernten Objekten auftritt; ein größerer Wert hält sehr große Szenen vollständig sichtbar.

Wenn ein Teil deiner Szene unerwartet verschwindet, prüfe, ob er zwischen diesen beiden Werten liegt. Für typische Avatar-Anwendungen sind die Standardwerte gut geeignet.

## Environment intensity {#env}

Environment intensity ist ein Multiplikator (0–2), der den Beitrag der Umgebungskarte (das HDRI-Hintergrundbild oder der Ambiente-Würfel) zur Beleuchtung von PBR- und MToon-Materialien in der Szene skaliert.

- **1,0** — die Umgebung beleuchtet die Szene in voller Stärke. Standard.
- **Unter 1,0** — der Beitrag der Umgebung wird abgedunkelt. Materialien erhalten weniger Fülllicht aus indirekten Richtungen, was den Kontrast erhöht und Szenenlichter dominanter macht.
- **0** — die Umgebungskarte trägt keine Beleuchtung bei. Das gesamte Licht stammt von expliziten Szenenlichtern (Punkt, Richtung usw.).
- **Über 1,0** — die Umgebung ist heller als normal; nützlich, wenn dein HDRI schwach ist und du mehr Umgebungsfülllicht ohne Änderung der Szenenlichter möchtest.

Diese Einstellung beeinflusst nicht das sichtbare Hintergrundbild, sondern nur die Beleuchtung der Materialien.
