# Transform {#transform}

![Koordinatenachsen](/help/diagrams/transform-axes.svg)

*Die Achsen X (rot), Y (grün, oben) und Z (blau). Position verschiebt einen Knoten entlang dieser Achsen, Rotation dreht ihn um sie, und Skalierung streckt ihn entlang dieser Achsen.*

Der Transform-Bereich bestimmt, wo sich ein Knoten in der Szene befindet, wie er ausgerichtet ist und wie er dargestellt wird — jeder Knoten besitzt einen.

## Position {#position}

Position verschiebt den Knoten im 3D-Raum entlang drei Achsen, gemessen in Szeneneinheiten (bei Standardskalierung ungefähr Meter):

- **X** — links (negativ) oder rechts (positiv)
- **Y** — unten (negativ) oder oben (positiv)
- **Z** — vorwärts, zur Kamera hin (negativ) oder rückwärts, von der Kamera weg (positiv)

Standardwert: X 0, Y 0, Z 0 (der Ursprung der Szene).

Wenn ein Knoten ein Kind eines anderen Knotens ist, ist seine Position relativ zum Elternknoten — wird der Elternknoten bewegt, bewegt sich das Kind mit.

## Rotation {#rotation}

Rotation kippt oder dreht den Knoten um jede Achse, in Grad:

- **X** — nach vorne oder hinten kippen (Nicken)
- **Y** — nach links oder rechts drehen (Gieren)
- **Z** — im oder gegen den Uhrzeigersinn rollen

Standardwert: X 0°, Y 0°, Z 0° (keine Rotation).

Die Rotation wird in der Reihenfolge X → Y → Z angewendet. Wie die Position ist auch die Rotation eines Kindknotens relativ zur Ausrichtung des Elternknotens.

## Scale {#scale}

Skalierung streckt oder verkleinert den Knoten unabhängig auf jeder Achse:

- **X** — Breite (links-rechts)
- **Y** — Höhe (oben-unten)
- **Z** — Tiefe (vorne-hinten)

Der Wert 1 entspricht der nativen Größe des Knotens. Werte unter 1 verkleinern den Knoten, Werte über 1 vergrößern ihn. Gleiche Werte auf allen drei Achsen ergeben eine gleichmäßige Größenänderung; unterschiedliche Werte strecken den Knoten ungleichmäßig. Negative Werte spiegeln den Knoten an der jeweiligen Achse.

Standardwert: X 1, Y 1, Z 1.

Kinder eines skalierten Elternknotens werden zusammen mit ihm skaliert.

## Opacity {#opacity}

Opacity steuert, wie transparent die Meshes des Knotens erscheinen. Der Regler läuft von 0 (vollständig transparent, unsichtbar) bis 1 (vollständig undurchsichtig). Zwischenwerte blenden den Knoten über das dahinterliegende Bild.

Standardwert: 1 (vollständig undurchsichtig).

Opacity wird gleichmäßig auf alle Meshes des Knotens angewendet, einschließlich Kind-Meshes. Schatten sind davon nicht betroffen.
