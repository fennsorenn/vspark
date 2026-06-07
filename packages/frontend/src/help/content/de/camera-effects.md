# Kameraeffekte {#camera-effects}

Kameraeffekte sind Post-Processing-Filter, die auf das gerenderte Bild einer Kamera angewendet werden, bevor es deinen Stream oder die Vorschau erreicht. Sie verändern nicht die 3D-Szene selbst, sondern transformieren das fertige Bild – vergleichbar mit einer Farbkorrektur oder einem Objektivfilter in der Dunkelkammer nach der Aufnahme. Mehrere Effekte werden in einer fest definierten Pipeline-Reihenfolge gestapelt, sodass das Ergebnis eines Effekts als Eingabe für den nächsten dient.

## Was Kameraeffekte sind {#what}

Jeder Effekt läuft als Schritt in der Post-Processing-Pipeline. Da sie nacheinander ausgeführt werden, hängt das Gesamtergebnis davon ab, welche Effekte gemeinsam aktiv sind – Bloom, der nach der Farbkorrektur läuft, leuchtet zum Beispiel mit den korrigierten Farben, nicht mit den Originalfarben. Die Reihenfolge der Pipeline ist fest (Farbanpassungen laufen zuerst, Tone Mapping zuletzt). Du steuerst den Look, indem du wählst, welche Effekte aktiviert sind und wie du sie einstellst.

Effekte sind nur für die Kamera aktiv, bei der das **✦**-Symbol im Szenenbaum leuchtet. Durch Deaktivieren dieses Symbols werden alle Effekte auf einmal ausgeschaltet, was nützlich ist, wenn du die volle Rendering-Leistung benötigst.

## Effekte hinzufügen und anordnen {#adding}

Effekte werden im **Szenenbaum** links verwaltet, nicht im Eigenschaften-Panel. Wähle einen Kameraknoten aus und nutze den Effekte-Bereich, der darunter erscheint:

- Klicke auf **+**, um einen neuen Effekt hinzuzufügen, und wähle den Typ aus der Liste.
- Nutze den **Umschalter** neben einem Effekt, um ihn zu aktivieren oder zu deaktivieren, ohne ihn zu entfernen.
- Klicke auf das **Papierkorb**-Symbol, um einen Effekt dauerhaft zu entfernen.
- Klicke auf den Namen eines Effekts, um seine Parametersteuerungen im Eigenschaften-Panel rechts zu öffnen.

Die Rendering-Reihenfolge ist durch die Pipeline festgelegt (Farbkorrektur → Bloom → Tiefe/Atmosphäre → Kanten → Verzerrung → Tone Mapping). Du kannst Effekte nicht manuell neu anordnen, aber die Reihenfolge, in der sie ausgeführt werden, ist konsistent und vorhersehbar.

---

## Tone Mapping {#tonemap}

Tone Mapping konvertiert die internen HDR-Werte des Renderings in den begrenzten Bereich, den ein Bildschirm darstellen kann. Der **Modus** bestimmt den Gesamtlook des gesamten Bildes: ACES Filmic liefert satten Kontrast mit angehobenen Schatten und einem leichten Farbshift (ein verbreiteter Filmstil); Neutral ist exakt und unverändert; Reinhard komprimiert Lichter weich; Linear wendet keine Kurve an, was flach wirkt, aber nützlich ist, wenn du mit anderen Effekten manuell korrigierst. Tone Mapping läuft immer als letzter Schritt in der Pipeline und beeinflusst das kombinierte Ergebnis aller darüber liegenden Effekte.

## Helligkeit / Kontrast {#colorgrade}

Passt die Gesamtbelichtung und Lebendigkeit des Bildes an. **Helligkeit** verschiebt das gesamte Bild in den Bereich −1 bis 1 heller (positiv) oder dunkler (negativ). **Kontrast** macht helle Bereiche heller und dunkle Bereiche dunkler (positive Werte) oder komprimiert alles in Richtung Grau (negative Werte). Beide Regler sind für Feineinstellungen gedacht, nicht für große Veränderungen.

## Farbton / Sättigung {#hue-saturation}

Verschiebt alle Farben im Spektrum und steuert ihre Leuchtkraft. **Farbton** dreht alle Farben gleichzeitig – ein kleiner Wert wie 0,1 erzeugt einen warmen oder kühlen Farbstich; größere Werte produzieren sichtbare Farbverschiebungen. **Sättigung** im Bereich −1 bis 1 skaliert die Farbintensität: 0 ist unverändert, −1 erzeugt Graustufen, positive Werte machen Farben lebendiger.

## Sepia {#sepia}

Mischt das Bild in warme Brauntöne, die an alte Fotografien erinnern. Der einzige **Intensität**-Regler (0–1) steuert, wie stark das Bild zu vollem Sepia verschoben wird; bei 0 ist der Effekt unsichtbar, bei 1 ist das Bild vollständig getönt.

## Bloom {#bloom}

Lässt helle Bereiche ein weiches Leuchten ausstrahlen, das in umgebende Pixel übergeht. Der Effekt ist auf Lichtern, neonähnlicher Beleuchtung und allen Oberflächen sichtbar, die merklich heller als ihre Umgebung sind.

- **Intensität** — wie hell das Leuchten insgesamt ist. Werte um 1–2 sind dezent; höhere Werte erzeugen starke Lichthöfe.
- **Luminance Threshold** — nur Pixel, die heller als dieser Wert sind, tragen zum Leuchten bei. Ein Wert von 0,9 bedeutet, dass nur fast weiße Bereiche leuchten; 0,5 beginnt, Mitteltöne einzubeziehen.
- **Luminance Smoothing** — weicht den Übergang an der Schwelle auf, sodass der Abschnitt nicht abrupt ist. Kleine Werte (0,01–0,05) geben eine klare Schwelle; größere Werte erzeugen einen sanften Übergang.

## Tiefenunschärfe (Depth of Field) {#dof}

Blendet Teile der Szene unscharf, die sich vor oder hinter der Fokusweite befinden, und imitiert den Schärfentiefe-Look eines echten Kameraobjektivs. Die unscharfen Bereiche verwenden einen Bokeh-Unschärfe-Effekt (scheibenförmig).

**Manueller Fokus** Parameter:
- **Fokusweite** — wie weit die scharfe Zone von der Kamera entfernt ist, in Welteinheiten (z. B. 3 = drei Meter).
- **Fokusbereich** — wie breit die scharfe Zone ist. Ein Bereich von 2 bedeutet, dass ungefähr ±1 Meter um die Fokusweite scharf bleibt.
- **Bokeh-Skalierung** — die Größe der Unschärfe-Scheiben in unscharfen Bereichen. Höhere Werte erzeugen eine ausgeprägtere Unschärfe.

**Autofokus**, wenn aktiviert, sampelt die Szenengeometrie, um die Fokusweite automatisch zu bestimmen:
- **AF-Modus — Punkt** sampelt die Szene an einer bestimmten Bildschirmposition (X/Y, 0–1 von oben links). Nutze dies, um ein bestimmtes Motiv scharf zu halten.
- **AF-Modus — Perzentil** verwendet eine statistische Stichprobe sichtbarer Tiefen und fokussiert auf das gewählte Perzentil (z. B. 15 = nähere Distanzen). Nützlich, um das nächstgelegene Objekt scharf zu halten, ohne einen festen Bildschirmpunkt anzusteuern.
- **Geschwindigkeit** steuert, wie schnell die Fokusweite konvergiert; **Verzögerung** fügt eine Pause vor dem Beginn der Bewegung hinzu (simuliert eine AF-Verzögerung).

## Chromatische Aberration {#chromatic}

Trennt die roten, grünen und blauen Farbkanäle um einen kleinen Versatz, was farbige Säume an kontrastreichen Kanten erzeugt – der Look eines billigen oder fehlerhaften Objektivs. **Offset X** und **Offset Y** legen die horizontale und vertikale Trennung als Bildschirmbruchteile fest (z. B. 0,002). Höhere Werte machen die Säume sichtbarer; Werte über 0,01 werden sehr ausgeprägt.

## Umgebungsokklusion (SSAO) {#ssao}

Fügt weiche Kontaktschatten in Ritzen und Ecken hinzu, wo Oberflächen nah beieinander sind. Dies verleiht der Szene mehr physisches Gewicht und Tiefe, ohne echte Lichtquellen hinzuzufügen.

- **Intensität** — wie dunkel die abgeschatteten Bereiche werden. Werte von 1–2 sind dezent; höhere Werte erzeugen stark verdunkelte Ritzen.
- **Radius** — wie breit ein Bereich um jeden Oberflächenpunkt gesampelt wird. Größere Werte spreizen den Schatten weiter von Kanten weg; kleinere Werte erzeugen engere, schärfere Kontaktschatten.
- **Bias** — ein kleiner Versatz, der verhindert, dass Oberflächen sich selbst fälschlicherweise abschatten. Erhöhe ihn leicht, wenn du dunkle Flecken auf flachen Oberflächen siehst.

## Kantenkonturen (Edge Outline) {#outline}

Zeichnet Linien entlang von Tiefen- und Oberflächennormalen-Kanten in der Szene und erzeugt einen Toon-/Cel-Shading-Look.

- **Farbe** — die Farbe der Konturen (Farbwähler).
- **Dicke** — wie viele Pixel breit jede Linie ist. Werte von 1–2 ergeben eine feine Linie; 4+ erzeugt dicke Cartoon-Konturen.
- **Alpha** — die Deckkraft der Konturlinien, 0 (unsichtbar) bis 1 (vollständig undurchsichtig).
- **Schwellenwert** — wie stark ein Tiefenunterschied sein muss, bevor eine Kontur gezeichnet wird. Niedrigere Werte zeichnen mehr Konturen; sehr niedrige Werte können jede Oberflächenvariation umreißen.

## Vignette {#vignette}

Verdunkelt die Ränder und Ecken des Bildes und lenkt den Blick des Betrachters zur Mitte hin. Häufig für einen kinematografischen oder fokussierten Eindruck verwendet.

- **Offset** — wie weit der dunkle Rand nach innen reicht (0–1). Niedrige Werte erzeugen einen schmalen Rand; hohe Werte greifen bis zur Bildmitte.
- **Dunkelheit** — wie dunkel der Rand wird (0–1). Ein Wert von 0,5 gibt eine moderate Abdunkelung; 1,0 macht die Ecken fast schwarz.

## Rauschen (Noise) {#noise}

Überlagert das gesamte Bild mit feinem Korn, ähnlich wie Filmkorn oder Sensorrauschen. Der einzige **Deckkraft**-Regler (0–1) steuert, wie sichtbar das Korn ist. Bei niedrigen Werten (0,05–0,15) fügt es eine dezente Textur hinzu; bei höheren Werten wird das Korn deutlich sichtbar.

## Scanlines {#scanline}

Überlagert gleichmäßig verteilte horizontale Linien über das Bild und imitiert das horizontale Abtastmuster eines CRT-Monitors.

- **Dichte** — wie viele Linien es pro Bildhöhe gibt. Höhere Werte erzeugen feinere, dichter gepackte Linien.
- **Deckkraft** — wie sichtbar die Linien sind (0–1). Niedrige Werte fügen eine dezente Textur hinzu; hohe Werte erzeugen stark sichtbare Streifen.

## Pixelung (Pixelation) {#pixelate}

Reduziert das Bild auf große quadratische Blöcke und verleiht ihm einen Retro-Pixel-Art- oder Lo-Fi-Look. Der einzige **Granularität**-Parameter legt die Blockgröße in Pixeln fest – ein Wert von 8 ergibt einen leicht verpixelten Look; 32 oder mehr produziert eine sehr grobe Pixelung.

## ASCII {#ascii}

Rendert die gesamte Szene als Raster aus ASCII-Textzeichen, wobei Helligkeit auf verschiedene Zeichen abgebildet wird. Das Ergebnis sieht aus wie klassische Computerterminal-Kunst.

- **Zellgröße** — die Größe jeder Zeichenzelle in Pixeln. Kleinere Werte erzeugen feinere Details (mehr Zeichen auf dem Bildschirm); größere Werte sind gröber.
- **Schriftgröße** — die Größe der Zeichen innerhalb jeder Zelle.
- **Farbe** — die Farbe der Zeichen (Farbwähler).
- **Zeichen** — die Zeichenpalette, von hell nach dunkel sortiert (z. B. ` .:-+*=%@#`). Zeichen am Anfang der Zeichenkette erscheinen in hellen Bereichen; Zeichen am Ende in dunklen Bereichen.

## Punktraster (Dot Screen) {#dotscreen}

Überlagert das Bild mit einem Halbton-Punktmuster und evoziert den Look von offsetgedrucktem Zeitungsdruck oder Vintage-Pop-Art.

- **Skalierung** — die Größe der Punkte. Größere Werte erzeugen größere, sichtbarere Punkte; kleinere Werte ergeben ein feineres Muster.
- **Winkel** — die Drehung des Punktrasters in Bogenmaß. Verschiedene Winkel können Moiré-Interferenzen mit anderen Mustern reduzieren.

## Glitch {#glitch}

Verschiebt in unregelmäßigen Abständen zufällig horizontale Streifen des Bildes, was einen digitalen Korruptions- oder Störsignal-Look erzeugt.

- **Verzögerung (min / max)** — der Bereich der Wartezeiten zwischen Glitch-Ereignissen, in Sekunden. Zum Beispiel bedeuten min 1,5 und max 3,5, dass ein Glitch ungefähr alle 1,5–3,5 Sekunden auftritt.
- **Stärke (min / max)** — der Bereich, wie weit die Streifen verschoben werden. Niedrige Werte (0,1–0,3) sind dezent; hohe Werte (0,7–1,0) erzeugen große Versätze.

## SMAA {#smaa}

Subpixel Morphological Anti-Aliasing. Glättet gezackte Kanten an Geometrie, indem Pixel entlang diagonaler Linien gemischt werden. Dieser Effekt hat keine konfigurierbaren Parameter – er ist entweder ein- oder ausgeschaltet. Er ist am nützlichsten bei Kameras, die mit niedrigerer Auflösung oder scharfkantigen Konturen rendern.

## Tilt Shift {#tiltshift}

Blendet einen horizontalen (oder rotierten) Bildstreifen unscharf und lässt nur einen schmalen Bereich scharf. Das Ergebnis lässt die Szene wie ein Miniaturmodell aussehen, das mit einem Tilt-Shift-Objektiv fotografiert wurde.

- **Fokusbereich** — die Breite des scharfen Streifens als Bruchteil der Bildhöhe (0–1). Ein Wert von 0,4 hält einen moderaten Bereich scharf; kleinere Werte erzeugen einen sehr schmalen Streifen.
- **Weichzeichnung** — wie sanft die Unschärfe an den Rändern des Fokusbereichs übergeht (0–1). Niedrige Werte erzeugen eine harte Kante zwischen Scharf und Unscharf; hohe Werte ergeben einen weichen Verlauf.
- **Versatz** — verschiebt den Fokusstreifen nach oben oder unten im Bild (−1 bis 1), sodass du den scharfen Bereich auf ein Motiv legen kannst, das nicht in der Mitte liegt.
- **Rotation** — neigt den Fokusstreifen in einem Winkel (in Bogenmaß).

## Wasser (Water) {#water}

Verzerrt das Bild mit einem Wellenmuster, als würde die Szene durch eine Wasseroberfläche betrachtet. Der einzige **Faktor**-Regler steuert die Intensität der Verzerrung. Niedrige Werte (0,2–0,5) erzeugen einen dezenten Schimmer-Effekt; höhere Werte produzieren starke Wellenverzerrungen.
