# Licht {#lighting}

Ein Licht-Knoten beleuchtet die Szene. Wähle ein Licht im Szenen-Graphen aus und bearbeite seine Parameter im Bereich **Eigenschaften**. Materialien im Toon-Stil (MToon) ignorieren Szenenlichter weitgehend, während realistische [Materialien](topic:materials#mode) vollständig auf sie reagieren.

## Lichttyp {#type}

Legt das physikalische Verhalten des Lichts fest.

- **Point** — strahlt Licht von einem einzelnen Punkt in alle Richtungen aus, wie eine Glühbirne. Die Helligkeit nimmt mit der Entfernung ab. Standard.
- **Directional** — wirft parallele Strahlen aus unendlicher Entfernung, wie Sonnenlicht. Jede Fläche im gleichen Winkel erhält dieselbe Intensität, unabhängig davon, wie weit sie vom Positionsmarker des Lichts entfernt ist. Die Position beeinflusst trotzdem die Schattenberechnung, da sie die Schattenkaamera-Platzierung bestimmt.
- **Ambient** — fügt allen Flächen gleichmäßig eine konstante Grundhelligkeit aus allen Richtungen hinzu. Kann keine Schatten werfen. Verwende es, um zu verhindern, dass eine Szene vollständig dunkel wird.
- **Spot** — strahlt einen Lichtkegel von einem Punkt aus, wie ein Bühnenstrahler. Die Ausrichtung wird durch Drehen des Knotens gesteuert.

## Farbe {#color}

Der Farbton des Lichts. Klicke auf das Farbfeld, um den Farbwähler zu öffnen. Standard ist Weiß (`#ffffff`). Ein warmes Orange simuliert Glühlampen; ein kühles Blau-Weiß simuliert bedecktes Tageslicht.

## Intensität {#intensity}

Die Helligkeit des Lichts. `0` bedeutet aus; `1` ist der Standardwert; Werte über `1` sind gültig und überbelichten nahe Flächen bei realistischen Materialien. Anpassung in Schritten von `0,1`. Für einen neutralen Studio-Look ist ein gerichtetes Hauptlicht bei etwa `1,0` kombiniert mit einem Umgebungslicht bei `0,3–0,5` ein häufiger Ausgangspunkt.

## Schatten {#shadows}

Steuert, ob dieses Licht Schatten berechnet und auf die Szene wirft. Dieser Abschnitt ist für Ambient-Lichter ausgeblendet, da diese keine Richtung haben und keine Schatten erzeugen können.

**Schatten werfen** (Kontrollkästchen) — aktiviert die Schattenberechnung für dieses Licht. Schatten sind standardmäßig deaktiviert. Schatten erscheinen in der Ausgabe nur, wenn auch die aktive Kamera ihre eigene Schatteneinstellung aktiviert hat (siehe Kamera-Eigenschaften). Bei aktivierten Schatten werden drei Unteroptionen angezeigt:

- **Kartengröße** — die Auflösung der Schattentextur in Pixeln (quadratisch). Optionen: 512, 1024 (Standard), 2048, 4096. Höhere Werte erzeugen schärfere Schattenkanten auf Kosten von GPU-Speicher. Für die meisten Stream-Anwendungsfälle ist 1024 ausreichend; verwende 2048, wenn Schattenkanten zu grob wirken.
- **Versatz (Bias)** — ein kleiner Tiefenversatz beim Schatten-Lookup, um „Shadow Acne" (dunkle Wellenartefakte auf beleuchteten Flächen) zu reduzieren. Standard ist `-0,0005`. Bei Acne den Wert etwas negativer setzen (z. B. `-0,001`). Bei „Peter-Panning" (Schatten lösen sich von Objekten) den Wert näher an null verschieben.
- **Schattenbereich** (nur Directional-Lichter) — die halbe Ausdehnung des orthografischen Schattenfrustums in Welteinheiten. Standard `10`. Alles innerhalb dieses Quadrats, zentriert auf das Ziel des Directional-Lichts, kann Schatten empfangen. Falls entfernte Objekte keinen Schatten haben, den Wert erhöhen; falls die Schattendetails grob wirken, den Wert verringern.
