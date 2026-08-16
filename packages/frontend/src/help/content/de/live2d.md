# Live2D-Modelle {#live2d}

vspark kann **Live2D-Cubism**-Modelle als 2D-Avatare („Puppets“) neben
3D-VRM-Avataren verwenden. Sie reagieren auf dasselbe Face-Tracking, denselben
Lipsync und dieselbe Motion-Capture, die du auch für einen 3D-Avatar nutzt.

Diese Seite behandelt, wie ein Modell *in* vspark hineinkommt. Wie du es
anschließend ansteuerst, steht bei den Behaviors des jeweiligen Objekts.

## Ein Live2D-Modell ist ein Ordner, keine Datei {#bundle}

Das ist das Wichtigste überhaupt — und die Ursache fast jedes fehlgeschlagenen
Uploads.

Während ein VRM-Avatar eine einzige, in sich geschlossene `.vrm`-Datei ist, ist
ein Live2D-Modell ein **Bundle**: mehrere Dateien, die nur zusammen funktionieren.

| Datei | Was sie ist | Nötig? |
| --- | --- | --- |
| `*.model3.json` | Das **Manifest** — listet alle anderen Dateien namentlich auf | Ja |
| `*.moc3` | Die Modelldaten selbst — Mesh und Verformungen | Ja |
| Texturen (`.png`) | Das Aussehen. Meist in einem Unterordner wie `meinmodell.2048/` | Ja |
| `*.physics3.json` | Schwingen von Haaren und Kleidung | Optional |
| `*.motion3.json` | Motions, meist im Unterordner `motion/` | Optional |
| `*.exp3.json` | Ausdrücke, meist im Unterordner `exp/` | Optional |
| `*.pose3.json`, `*.cdi3.json`, `*.userdata3.json` | Zusätzliche Modellinformationen | Optional |

Das Manifest verweist auf die anderen Dateien **über deren Pfad relativ zu sich
selbst** — es fragt also etwa nach `meinmodell.2048/texture_00.png`, was bedeutet:
„ein Ordner namens `meinmodell.2048` neben mir, der `texture_00.png` enthält“.

**Diese Ordnerstruktur ist Teil des Modells.** Werden die Dateien verschoben,
umbenannt oder aus ihren Unterordnern herausgeholt, findet das Manifest sie nicht
mehr und das Modell lässt sich nicht laden — obwohl technisch noch jede Datei da
ist.

## Ein Modell hochladen {#uploading}

1. Öffne den **Assets**-Dock und wechsle zum Tab **Modelle**.
2. Klicke auf **Live2D hochladen**.
3. Wähle den **Ordner**, der die `*.model3.json` enthält — nicht eine einzelne
   Datei darin.

Die meisten Modelle werden als `.zip` verteilt. Entpacke es zuerst und lasse die
Ordnerstruktur genau so, wie sie aus dem Archiv kommt. Enthält das Archiv einen
Ordner wie `Hiyori/runtime/`, ist meist dieser `runtime`-Ordner — der mit der
`*.model3.json` — der richtige.

Nach dem Upload erscheint das Modell im Tab „Modelle“. Mit **Zur Szene
hinzufügen** platzierst du es, oder du wählst ein vorhandenes Live2D-Objekt aus
und nutzt **Anwenden**.

Beachte: vspark lädt **ein Modell auf einmal** hoch. Enthält ein Ordner mehrere
`*.model3.json`-Dateien, sagt vspark das, statt zu raten, welches Modell gemeint
war — lade jedes Modell aus seinem eigenen Ordner hoch.

## Fehlende Dateien {#missing-files}

Beim Upload liest vspark das Manifest und prüft, ob jede darin genannte Datei
tatsächlich vorhanden ist. Fehlt etwas, nennt vspark genau die betroffenen
Dateien und die erwarteten Pfade — statt ein Modell anzunehmen, das später
kommentarlos nichts anzeigt.

Fehlende Dateien gibt es in zwei Ausprägungen.

### Erforderlich — das Modell kann nicht dargestellt werden {#required}

Die **Modelldaten** (`.moc3`) und die **Texturen** blockieren das Laden: ohne sie
gibt es weder Form noch Bild, also nichts zu zeichnen. Fehlen sie, wird der
Upload **abgelehnt** und nichts gespeichert.

Die übliche Ursache ist ein **flach gemachter Ordner** — alle Dateien liegen
nebeneinander auf oberster Ebene, während das Manifest die Texturen in einem
Unterordner erwartet. Sieh dir die von vspark genannten Pfade an: verlangt es
`meinmodell.2048/texture_00.png` und in deinem Ordner liegt nur ein loses
`texture_00.png` ganz oben, ist die Struktur irgendwo zwischen Download und
Festplatte verloren gegangen.

So behebst du es:

- **Lade das Modell neu herunter oder entpacke es erneut** und achte darauf, dass
  dein Entpack-Programm Ordner beibehält. Manche Programme machen Archive
  standardmäßig flach.
- **Lege die Ordner von Hand wieder an**, wenn du weißt, wohin die Dateien
  gehören: erstelle den im Manifest genannten Unterordner und verschiebe die
  Dateien hinein.
- Lade den Ordner anschließend erneut hoch.

vspark rät bewusst **nicht**. Ein loses `texture_00.png` kann die vom Manifest
gesuchte Datei sein — oder zu einem ganz anderen Textursatz gehören. Falsch
geraten entsteht ein Modell, das falsch aussehend lädt; das fällt schwerer auf
und ist schwerer zu debuggen als eines, das sich schlicht nicht laden lässt.

### Optional — das Modell funktioniert, nur mit weniger {#optional}

Motions, Ausdrücke, Physik, Pose und Anzeigeinfos sind Ergänzungen. Ein Modell
ohne jede Motion wird trotzdem einwandfrei dargestellt — es steht dann eben still.

Fehlen nur solche Dateien, **gelingt** der Upload und du bekommst einen Hinweis
mit der Liste. Du kannst ihn ignorieren — oder ihn, falls du diese Motions
erwartet hättest, als Zeichen für einen unvollständigen Download nehmen.

### Probleme im Manifest {#manifest-problems}

Gelegentlich ist das Manifest selbst fehlerhaft statt nur unvollständig: es ist
kein gültiges JSON, enthält keine Dateiliste oder verweist aus seinem eigenen
Ordner heraus. Zusätzliche Dateien helfen hier nicht. Exportiere das Modell
erneut aus Cubism oder lade es neu von der Quelle herunter.

## Lizenzen {#licensing}

Für die Live2D-Darstellung wird die proprietäre **Cubism-Core**-Laufzeit
benötigt, die vspark nicht mitliefert. Beim ersten Einsatz eines Live2D-Modells
wirst du gebeten, die Bedingungen von Live2D zu akzeptieren; die Laufzeit wird
danach direkt von Live2D geladen. Bis dahin wird kein Live2D-Code
heruntergeladen.

Ein Modell zu verwenden bedeutet außerdem, **dessen eigene** Lizenz zu beachten —
viele Modelle schränken kommerzielle Nutzung oder Streaming ein. Das ist eine
Sache zwischen dir und der Person, die das Modell erstellt hat.
