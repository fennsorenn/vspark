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

Wenn beides aktiv ist, überblendet vspark sie, damit der Übergang sanft wirkt
statt zu springen. Die Überblendzeit lässt sich pro Avatar einstellen.

> Tipp: Wirkt dein Avatar eingefroren, prüfe, ob ein Motion-Capture-Verhalten
> angehängt und verbunden ist — siehe [Verhalten](topic:behaviors).

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
