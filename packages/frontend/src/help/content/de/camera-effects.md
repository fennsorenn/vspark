# Kameraeffekte {#camera-effects}

**Kameraeffekte** sind visuelle Filter, die auf das Bild einer Kamera
angewendet werden – vergleichbar mit Instagram-Filtern für deine 3D-Szene. Sie
laufen als Post-Processing-Stapel und verarbeiten das fertige Bild, bevor es
auf deinem Stream landet.

## Was sind Kameraeffekte? {#what}

Jeder Effekt ist eine separate Schicht, die das Bild in einem Schritt
verändert. Da sie **gestapelt** werden, ist die Reihenfolge wichtig:
Farbanpassungen erfolgen vor Bloom, Bloom vor Unschärfe und so weiter. Du
kannst mehrere Effekte gleichzeitig auf derselben Kamera haben – jeder kann
unabhängig ein- oder ausgeschaltet werden.

Effekte gelten nur für Kameras, bei denen das ✦-Vorschau-Symbol im
Szenenbaum aktiv ist. Du kannst alle Effekte auf einmal deaktivieren, indem du
diese Kamera abwählst.

## Ein Überblick über häufige Effekte {#common}

### Glanz und Farbe

- **Bloom** — lässt helle Bereiche weich nach außen leuchten. Ideal für
  Neonlichter, Magie-Effekte oder einen verträumten Look.
- **Tone Mapping** — steuert die Helligkeitskurve des Renderings, von einem
  flachen „linearen" Look bis hin zu filmischen Stilen wie ACES, die Schatten
  anheben und Kontrast hinzufügen.
- **Helligkeit / Kontrast** — macht das gesamte Bild heller oder dunkler und
  passt an, wie stark der Unterschied zwischen hellen und dunklen Bereichen
  wirkt.
- **Farbton / Sättigung** — verschiebt alle Farben gleichzeitig (Farbton)
  oder erhöht bzw. verringert die Farbintensität (Sättigung).
- **Sepia** — mischt das Bild in warme Brauntöne für einen Vintage-Look.

### Tiefe und Fokus

- **Tiefenunschärfe** — blendet Teile der Szene unscharf, die sich vor oder
  hinter dem Fokuspunkt befinden, ähnlich wie bei einem echten Kameraobjektiv.
  Ein Autofokus-Modus lässt vspark die Fokusweite automatisch bestimmen.
- **Tilt-Shift** — blendet einen horizontalen oder diagonalen Streifen des
  Bildes unscharf und lässt nur einen scharfen Bereich in der Mitte übrig.
  Szenen wirken dadurch wie Miniaturmodelle.

### Atmosphäre und Textur

- **Vignette** — verdunkelt die Ecken des Bildes und lenkt den Blick nach
  innen.
- **Umgebungsokklusion (SSAO)** — fügt weiche Kontaktschatten an Stellen
  hinzu, wo sich Oberflächen berühren, und verleiht der Szene mehr Tiefe.
- **Kontur** — zeichnet farbige Linien entlang von Oberflächenkanten für
  einen Toon-/Cel-Animations-Look.
- **Lichtstrahlen (God Rays)** — Lichtstrahlen, die von einem hellen Punkt
  ausgehen (erfordert einen „God Ray Caster"-Knoten in der Szene als
  Lichtquelle).

### Stilisiert und künstlerisch

- **Chromatische Aberration** — spaltet Farben an den Rändern auf und imitiert
  ein billiges Objektiv oder eine fehlerhafte Kamera.
- **Rauschen** — legt ein feines Korn für eine filmähnliche Textur überlagert.
- **Scanlines** — horizontale Linien im Bild für einen Retro-CRT-Look.
- **Pixelung** — reduziert die Auflösung in Blöcken für einen Lo-Fi-Pixel-Art-Stil.
- **ASCII** — rendert die Szene als ASCII-Zeichen.
- **Punktraster** — Halbton-Punktmuster wie altes Zeitungsdruck.
- **Glitch** — verzerrt das Bild zufällig in Scheiben für einen
  Störsignal-Effekt.
- **Wasser** — bewegt das Bild wellenförmig, als würde es durch Wasser gesehen.

## Effekte hinzufügen, entfernen und neu anordnen {#adding}

Effekte werden im **Szenenbaum** (linkes Panel) verwaltet, nicht in den
Eigenschaften. Wähle deinen Kameraknoten aus und suche den Effekte-Bereich
unterhalb der Knotenzeile. Von dort kannst du:

- **Hinzufügen**: Klicke auf die Schaltfläche **+** und wähle einen Typ aus
  der Liste.
- **Aktivieren / Deaktivieren**: Mit dem Umschalter – der Effekt bleibt
  gespeichert, aber wird nicht gerendert, bis du ihn wieder aktivierst.
- **Entfernen**: Mit dem Papierkorb-Symbol.
- **Bearbeiten**: Klicke auf einen Effekt – dadurch öffnen sich die
  Effekteinstellungen im Eigenschaften-Panel rechts.

Die Rendering-Reihenfolge ist fest (Farbkorrektur → Bloom → Tiefeneffekte →
Kanten → Verzerrung → Lichtstrahlen → Tone Mapping). Die einzige Reihenfolge,
die für deinen Stream zählt, ist also, welche Effekte du aktivierst.
