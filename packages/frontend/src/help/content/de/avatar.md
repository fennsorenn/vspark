# Avatar {#avatar}

Ein **Avatar** ist die 3D-Figur, die du steuerst. vspark nutzt das offene
**VRM**-Format, sodass jede `.vrm`-Datei funktioniert — egal ob selbst erstellt
oder heruntergeladen. Sobald ein Avatar auf der [Stage](topic:scene) ist,
treiben ihn Verhalten und Bewegungsdaten in Echtzeit an.

## Eine Figur laden {#loading}

Füge der Szene einen Avatar-Knoten hinzu und wähle dann eine `.vrm`-Datei zum
Laden aus. Die Datei wird mit deinem Projekt gespeichert und beim nächsten Mal
automatisch wieder geladen.

Ein frisch geladener Avatar steht in einer neutralen Ruhepose. Er beginnt sich
erst zu bewegen, wenn ihn ein [Verhalten](topic:behaviors) mit Bewegung
versorgt — zum Beispiel Webcam-Tracking oder eine VMC-Verbindung.

## Animation {#animation}

Animation ist Bewegung, die über die Zeit auf das Skelett des Avatars angewendet
wird. Sie stammt aus zwei Hauptquellen:

- **Live-Bewegung** — von deiner Webcam, deinem Smartphone oder Tracking-Hardware
  erfasst und Bild für Bild angewendet. Das lässt den Avatar dich spiegeln.
- **Animations-Clips** — vorab aufgezeichnete Bewegungen (Stehen, Winken,
  Tanzen), die du auslösen kannst. Sie sind nützlich für Momente, in denen du
  nicht aktiv getrackt wirst.

Die **Leerlauf-Animation** ist eine Basisschleife, die fortlaufend läuft, solange
nichts anderes den Avatar steuert. Sie ist an eine gemeinsame Uhr gekoppelt,
sodass alle Betrachter — auch Mitbearbeiter — sie an derselben Stelle der
Schleife sehen.

Wenn beides aktiv ist, überblendet vspark sie, damit der Übergang sanft wirkt
statt zu springen. Die Überblendzeit lässt sich pro Avatar einstellen.

> Tipp: Wirkt dein Avatar eingefroren, prüfe, ob ein Motion-Capture-Verhalten
> angehängt und verbunden ist — siehe [Verhalten](topic:behaviors).

## Bewegungsdynamik {#snappiness}

Motion-Capture-Daten werden meist schon geglättet, bevor sie vspark erreichen,
und vspark glättet sie erneut, um Netzwerk-Aussetzer abzufangen. Das hält die
Bewegung stabil, kann sie aber auch weich oder schwebend wirken lassen. Die
**Bewegungsdynamik** gibt der Bewegung wieder Schärfe, ohne erneut Ruckeln
einzuführen.

Aktiviere sie pro Avatar und stelle dann drei Regler ein:

- **Frequenz** — wie schnell der Avatar reagiert. Höher wirkt dynamischer; sehr
  hoch kann zappelig aussehen.
- **Dämpfung** — wie stark er ausschwingt statt nachzufedern. Um 1 stoppt sauber
  ohne Überschwingen; unter 1 entsteht ein lebendiges Überschwingen (der
  „Schwung"); über 1 wirkt schwer und träge.
- **Reaktion** — wie eifrig er in eine Bewegung hineingeht. 0 ist neutral; höhere
  Werte lassen den Avatar die Bewegung vorwegnehmen und kräftiger einsetzen.

> Tipp: Beginne mit den Standardwerten und senke dann die **Dämpfung** leicht für
> mehr Schwung. Fängt die Bewegung an zu wackeln oder zu schwingen, erhöhe die
> **Dämpfung** oder senke die **Frequenz**.

## Mimik {#expressions}

Mimik sind im VRM definierte Gesichtsposen wie Lächeln, Blinzeln oder
Mundformen für Vokale. Sie werden getrennt von der Körperbewegung gesteuert:

- **Lippensynchronisation** wandelt dein Mikrofonaudio in Mundformen um.
- **Gesichts-Tracking** überträgt deine echte Mimik von der Webcam.
- **Standard-Mimik** legt ein Ruhegesicht fest, das der Avatar hält, wenn nichts
  anderes es überschreibt.

## Materialien {#materials}

Materialien bestimmen, wie die Oberfläche des Avatars im Licht aussieht. Jedes
Material des Modells kann einen von mehreren Stilen verwenden:

- **Toon** — flache Schattierung im Anime-Stil, die das meiste Szenenlicht
  ignoriert.
- **Realistisch** — reagiert auf die Lichter und Reflexionen deiner Szene für
  einen physikalischeren Look.

Du kannst den Stil pro Material wechseln und jederzeit auf den ursprünglich
erstellten Zustand zurücksetzen.

## Kalibrierung {#calibration}

Die Kalibrierung gleicht Unterschiede zwischen deinem Körper und den Proportionen
des Avatars aus, damit die Bewegung natürlich passt — zum Beispiel die Anpassung
deiner Armlänge an die der Figur. Die meisten Tracking-Verhalten enthalten einen
Kalibrierungsschritt; folge der Anweisung auf dem Bildschirm, während du in einer
neutralen Pose stehst.

## Unterarm-Drehung {#twist}

Wenn der Avatar das Handgelenk dreht (Pronation/Supination), hat ein
Standard-VRM nur einen Unterarmknochen, sodass die gesamte Drehung am Ellbogen
landet — der Unterarm sieht aus wie ein ausgewrungenes Tuch. **Drehknochen
erzwingen** fügt jedem Unterarm einen versteckten Hilfsknochen hinzu und
gewichtet den Unterarm neu, damit sich die Drehung gleichmäßig vom Ellbogen zum
Handgelenk verteilt, wie bei einem echten Arm. Die Hand behält exakt dieselbe
Ausrichtung; nur die Fläche dazwischen wird geglättet.

Wenn das Modell mit eigenen Unterarm-Drehknochen erstellt wurde, werden diese
automatisch verwendet und der Schalter ist überflüssig. Der Schalter wirkt sich
nicht auf die Ruhepose aus — der Unterschied ist nur sichtbar, während das
Handgelenk gedreht wird.

**Ärmel ausschließen** hält die Drehung von losen Ärmeln und Manschetten fern,
sodass sich ein weiter Ärmel mit dem Arm beugt, ohne sich wie Haut zu drehen.
Dabei bleibt die Drehung nur auf Flächen, die mit der Hand verbunden sind;
separate Kleidungsstücke werden ausgelassen. Schalte es aus, wenn sich ein eng
anliegender Ärmel mit dem Arm drehen soll oder wenn ein Ärmel die einzige
Unterarm-Geometrie des Modells ist.
