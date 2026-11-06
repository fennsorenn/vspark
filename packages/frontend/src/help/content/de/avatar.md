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

Tracking ist selten perfekt: Das Signal kann kurz einfrieren oder ein paar Pakete
können ausbleiben, ohne dass die Verbindung tatsächlich abbricht. **Leerlauf
nach** legt fest, wie lange eine solche Lücke toleriert wird, bevor der Avatar
aufgibt und in seine Leerlauf-Animation zurückkehrt. Erhöhe den Wert, wenn dein
Avatar bei kurzen Aussetzern in den Leerlauf fällt; verringere ihn, wenn er nach
dem Ende des Trackings zu lange in einer eingefrorenen Pose verharrt. Der Wert
ergänzt die Überblendzeit: Diese Einstellung bestimmt, *wann* die Rückkehr in den
Leerlauf beginnt, die Überblendzeit, *wie schnell* sie abläuft. Alle
Tracking-Quellen des Avatars (VMC, Kamera-Tracking) nutzen dieselbe Einstellung.

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

## Tracking-Mix {#tracking-mix}

Der **Tracking-Mix** legt fest, wie stark jede Quelle deinen Avatar bewegt. Eine
Quelle ist die **Animation** (Basis- oder Leerlauf-Clip) oder eines der
Tracking-Verhalten des Avatars — VMC, iFacialMocap, Webcam-Tracking, Atmung,
Lippensynchronisation und so weiter. So kannst du zum Beispiel eine
Tanz-Animation auf den **Beinen** abspielen, während Live-Tracking den
**Oberkörper** steuert, oder das Webcam-Tracking den Kopf lenken lassen,
während ein VMC-Sender die Arme übernimmt.

In der Seitenleiste hat jede Quelle einen Regler, der ihr Gewicht überall
setzt. Klicke auf **Mixer öffnen…** für den vollständigen Editor:

- **Körper** — ein Raster aus Körperbereichen (**Kopf**, **Blick**,
  **Körper**, **Arme**, **Hände**, **Beine**) × Quellen. Klicke auf einen
  Bereich, um ihn aufzuklappen und einzelne Knochen einzustellen.
- **Gesicht** — die Mimiken des Modells, gruppiert in **Mund**, **Augen**,
  **Brauen**, **Emotionen** und **Sonstige**, × die Quellen, die Mimik senden.

Jedes Gewicht reicht von **0** bis **2**:

- **1** — die Quelle in voller Stärke (überall der Standard).
- **0** — die Quelle hat dort keinen Einfluss.
- **Zwischen 0 und 1** — die Quelle wird abgeschwächt.
- **Über 1** — die Quelle wird verstärkt, z. B. um einen zurückhaltenden Sender
  zu übertreiben.

Tracking wird **auf die Animation gestapelt**. Ein Bereich startet in der
Ruhepose, das Animationsgewicht blendet den Clip ein, und die Rotation jeder
Tracking-Quelle wird darübergelegt, skaliert mit ihrem Gewicht. Die Gewichte
müssen sich **nicht** zu 1 addieren: Zwei Quellen mit je 0,5 mitteln sich
ungefähr, während Atmung mit 1 auf vollem Tracking ihre Bewegung hinzufügt. Ein
Körperteil, den jede Tracking-Quelle mit 0 gewichtet, folgt allein der
Animation; eine Mimik, die jede Quelle mit 0 gewichtet, kehrt zur
Standard-Mimik zurück.

**Bereiche und einzelne Knochen.** Ein Bereichsregler (oder eine
Gesichtsgruppe, oder der Regler in der Seitenleiste) setzt alle Knochen darin.
Sobald du einen einzelnen Knochen änderst, zeigt der Bereich **Individuell**
statt eines Reglers. Sein Zurücksetzen-Knopf setzt alle Knochen des Bereichs auf
den Wert, den die meisten schon haben (bei Gleichstand den höheren), oder auf 1,
wenn sich kein Wert wiederholt.

> Die Animationsgewichte wirken nur, **solange eine Tracking-Quelle aktiv ist**.
> Ist das Tracking verloren — oder gar keine Tracking-Quelle aktiviert —, läuft
> die **Leerlauf-Animation** in voller Stärke; ein niedriges Animationsgewicht
> schwächt deine Leerlauf-Animation also nie ab.

> Die Hüfte gehört zum Bereich **Beine** — sowohl ihre Rotation als auch ihre
> **Position** (die Root-Motion: das Auf-und-Ab-Wippen und die
> Gewichtsverlagerung, die ein Clip mitbringt), da die Hüfte die untere
> Körperhälfte führt. Ein Animationsgewicht von 0 auf der Hüfte hält sie also an
> Ort und Stelle, während der Bereich **Körper** Wirbelsäule und Brust abdeckt.

### Reihenfolge der Quellen {#tracking-mix-order}

Der Reiter **Körper** zeigt die Tracking-Quellen in der Reihenfolge, in der sie
von links nach rechts auf die Animation angewendet werden. Mit den Pfeilen
verschiebst du eine Quelle nach vorn oder hinten. Die Reihenfolge zählt nur,
wenn zwei Quellen **denselben** Knochen in **verschiedene** Richtungen drehen —
Rotationen verketten sich wie erst Drehen und dann Kippen, was woanders endet
als erst Kippen. Mimiken werden einfach addiert, ihre Reihenfolge spielt also
keine Rolle.

### Basis-Animation {#base-animation}

Die **Basis-Animation** (im Animations-Abschnitt einstellbar) ist die Schleife,
auf die Tracking gestapelt wird, solange eine Tracking-Quelle verbunden ist —
getrennt von der **Leerlauf-Animation**. Bei Tracking-Verlust fällt der Avatar
auf den Leerlauf zurück. Ohne gesetzte Basis-Animation dient der Leerlauf als
Basis.

Beide Schleifen lassen sich direkt im **Assets**-Panel zuweisen: bei
ausgewähltem Avatar zeigt jeder Animations-Clip die Schaltflächen **Als Idle
setzen** und **Als Basis setzen**.

> Hinweis: Beine per Tracking brauchen eine Ganzkörperquelle (ein Ganzkörper-
> VMC-Sender). Webcam-Tracking sendet noch keine Beine — mit einer Webcam folgen
> die Beine also der Animation; der **Tracking-Mix** kann keine Beinbewegung
> hinzufügen, die keine Quelle sendet.

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
