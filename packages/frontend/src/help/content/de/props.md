# Requisiten {#props}

Requisiten sind zusätzliche Objekte, die du neben deinem Avatar in der 3D-Szene platzierst: Bildebenen, Videoebenen, Audioquellen, Textlabels, Partikelemitter und szeneneigene Feed-Overlays. Wähle einen Requisiten-Knoten aus, um seine Parameter im Eigenschaften-Panel zu sehen und zu bearbeiten.

## Bild (Billboard) {#image}

Eine Bildebene zeigt ein Standbild als flaches Rechteck in der 3D-Welt an. Lade eine PNG- oder JPG-Datei über das Assets-Panel hoch und weise sie hier zu.

**Bild (Textur-URL)** — die Datei oder URL des anzuzeigenden Bilds. Nutze die Pick-Schaltfläche, um hochgeladene Assets zu durchsuchen, oder füge eine URL direkt ein. Ohne Zuweisung erscheint ein weißes Rechteck.

**Ausrichtung** — wie die Ebene relativ zur Kamera orientiert ist:

- `Bildschirm` — die Ebene dreht sich immer zur Kamera hin, wie ein Sprite. Das Bild ist unabhängig von der Kameraposition immer lesbar. Gut für Logos, Icons und flache Dekorationen.
- `Welt` — die Ebene hat eine feste Ausrichtung im 3D-Raum. Drehe sie über die Transform-Steuerelemente. Gut für Bilderrahmen, Schilder oder Flächen, die in einem bestimmten Winkel verbleiben sollen.

**Rückseite** — was auf der Rückseite der Ebene (der von der Front abgewandten Seite) angezeigt wird:

- `Keine` — keine Rückseite; die Ebene ist von hinten unsichtbar.
- `Gespiegelt` — das Bild wird horizontal gespiegelt auf der Rückseite angezeigt. Gut für Schilder, die von beiden Seiten lesbar sein sollen.
- `Ungespiegelt` — das Bild wird ungespiegelt auf der Rückseite angezeigt. Gut für doppelseitige Poster, bei denen ein Spiegeln falsch wirken würde.

**Breite** — die Breite der Ebene in Welteinheiten. Standard: 1. Eine Welteinheit entspricht ungefähr der Körpergröße eines Avatars. Erhöhe den Wert für ein größeres Bild; verringere ihn für kleine Sticker.

**Höhe** — die Höhe der Ebene in Welteinheiten. Standard: 1. Passe diesen Wert unabhängig von der Breite an, um das Seitenverhältnis deines Bilds zu berücksichtigen.

**Alpha** — die Gesamtdeckkraft der Ebene, von 0 (unsichtbar) bis 1 (vollständig opak). Standard: 1. Ein niedrigerer Wert blendet das Bild gleichmäßig aus — nützlich für dezente Hintergrundebenen.

## Video {#video}

Eine Videoebene spielt eine Videodatei in der Szene ab. Die Ebenengeometrie funktioniert identisch zum Bild-Billboard, mit zusätzlichen Wiedergabe- und Compositing-Steuerelementen.

**Quelle** — die Videodatei oder URL, die abgespielt werden soll. Nutze die Pick-Schaltfläche, um ein hochgeladenes Video-Asset auszuwählen.

### Wiedergabe {#video-playback}

**Autoplay** — wenn aktiviert, beginnt das Video zu spielen, sobald die Szene lädt. Standard: ein. Deaktiviere dies, um die Wiedergabe über eine Logik-Automatisierung oder einen Track-Clip zu starten.

**Schleife** — wenn aktiviert, startet das Video von vorne, wenn es das Ende erreicht. Standard: ein.

**Am Ende** — was passiert, wenn das Video das letzte Bild erreicht und Schleife ausgeschaltet ist:

- `Einfrieren` — das Video pausiert beim letzten Bild. Die Ebene bleibt sichtbar. Standard.
- `Ausblenden` — die Ebene verschwindet, wenn das Video endet.

**Stummgeschaltet** — wenn aktiviert, wird die Tonspur des Videos stumm geschaltet. Standard: ein. Deaktiviere dies, um den eigenen Ton des Videos zu erlauben; nutze Lautstärke für den Pegel.

**Lautstärke** — der Wiedergabepegel der Videotonspur, von 0 bis 1. Standard: 1. Nur hörbar, wenn Stummgeschaltet deaktiviert ist.

### Chroma-Keying {#video-chroma}

Chroma-Keying entfernt eine bestimmte Hintergrundfarbe aus dem Video und macht diese Farbe transparent. Nutze dies, um Greenscreen- oder Bluescreen-Videos direkt in der 3D-Szene zu compositen.

**Chroma-Key (aktiviert)** — Checkbox, die den Chroma-Key-Shader aktiviert. Die nachfolgenden Regler wirken sich nur aus, wenn diese Option eingeschaltet ist.

**Key-Farbe** — die zu entfernende Farbe. Klicke auf das Farbfeld, um den Farbwähler zu öffnen. Standard: Reingrün (#00ff00). Stelle diese Farbe passend zur Hintergrundfarbe deines Videomaterials ein.

**Ähnlichkeit** — wie nah die Farbe eines Pixels an der Key-Farbe liegen muss, bevor es transparent gemacht wird, von 0 bis 1. Standard: 0,4. Niedrigere Werte entfernen nur Pixel, die der Key-Farbe sehr ähnlich sind (weniger Spill entfernt, härtere Kante). Höhere Werte entfernen einen breiteren Farbbereich (mehr Hintergrund entfernt, aber möglicherweise auch Kanten des Motivs).

**Weichheit** — steuert die Weichheit der Kante zwischen entfernten und erhaltenen Bereichen, von 0 bis 1. Standard: 0,08. Bei 0 ist die Kante ein harter Schnitt. Erhöhe den Wert, um Kanten zu weichen und gezackte Konturen zu reduzieren — nützlich bei feinem Haar oder weichen Konturen des Motivs.

**Spill** — wie aggressiv grüne (oder key-farbige) Tönung von den Kanten des Motivs entfernt wird, von 0 bis 1. Standard: 0,1. Wenn ein Motiv neben einem Greenscreen beleuchtet wird, nehmen seine Kanten oft einen grünlichen Schimmer an. Eine Erhöhung des Spill-Werts desaturiert diesen Randbereich. Zu hohe Werte können die Sättigung von Hauttönen nahe der Kante verringern.

**Ebenensteuerung** — die Videoebene teilt dieselben Ausrichtungs-, Rückseiten-, Breiten-, Höhen- und Alpha-Steuerelemente wie das Bild-Billboard. Siehe den Abschnitt [Bild](#image) oben für deren Beschreibungen. Die Standardwerte weichen ab: Ausrichtung ist standardmäßig `Welt` und die Abmessungen sind 1,6 × 0,9 (16:9-Seitenverhältnis).

**Mischmodus** — wie das Videobild über der Szene compositet wird:

- `Normal` — Standard-Alpha-Compositing. Das Video verdeckt das Dahinterliegende entsprechend seinem Alpha. Standard.
- `Additiv` — die Videofarbe wird zur Szene addiert. Transparente oder dunkle Bereiche des Videos lassen die Szene durchscheinen und akkumulieren Helligkeit. Gut für Leuchten oder Lichteffekte.
- `Multiplizieren` — die Videofarbe wird mit der Szene multipliziert. Dunkelt das Dahinterliegende ab; Weiß im Video ist transparent. Gut für Schattenüberlagerungen.
- `Negativ multiplizieren` — eine weiche Aufhellmischung, die die Szene aufhellt, ohne die Härte von Additiv. Gut für Nebel, Dunst oder dezentes Aufhellen.

## Audio {#audio}

Ein Audio-Knoten spielt eine Sounddatei in der Szene ab. Er hat keine sichtbare Geometrie.

**Quelle** — die Audiodatei oder URL, die abgespielt werden soll. Nutze die Pick-Schaltfläche, um ein hochgeladenes Audio-Asset auszuwählen.

**Typ** — wie das Audio räumlich dargestellt wird:

- `Einfach` — der Klang spielt mit gleicher Lautstärke überall in der Szene, unabhängig von Kamera- oder Hörposition. Gut für Hintergrundmusik, Ambient-Schleifen oder jeden Klang, der global hörbar sein soll. Standard.
- `Direktional` — der Klang nimmt mit dem Abstand ab und kann in einen Kegel geformt werden. Erfordert die Konfiguration des Räumlichkeits-Abschnitts. Gut für szeneneigene Lautsprecher, Charakterstimmen oder Klangquellen, die im 3D-Raum positioniert wirken sollen.

### Wiedergabe

**Autoplay** — wenn aktiviert, beginnt die Wiedergabe, sobald die Szene lädt. Standard: ein.

**Schleife** — wenn aktiviert, startet das Audio neu, wenn es das Ende erreicht. Standard: aus.

**Lautstärke** — Wiedergabepegel von 0 bis 1. Standard: 1.

### Räumlichkeit (nur direktional) {#audio-spatial}

Diese Steuerelemente erscheinen nur, wenn der Typ auf `Direktional` gesetzt ist. Sie nutzen das `PannerNode`-Modell der Web Audio API.

**Referenzabstand** — der Abstand (in Welteinheiten), bei dem der Klang mit seiner eingestellten Lautstärke ohne Abfall spielt. Standard: 1. Wenn der Hörer näher als dieser Abstand ist, erhöht sich die Lautstärke nicht weiter. Setze einen kleinen Wert (0,5 – 1) für eine enge Quelle; erhöhe ihn, damit die volle Lautstärke über einen weiteren Radius hörbar ist.

**Rolloff-Faktor** — wie schnell die Lautstärke jenseits des Referenzabstands abnimmt. Standard: 1. Höhere Werte (2 – 3) lassen den Klang scharf mit dem Abstand abfallen. Niedrigere Werte (0,1 – 0,5) tragen den Klang viel weiter, bevor er unhörbar wird. Auf 0 gesetzt gibt es keine Abstandsdämpfung.

**Maximaler Abstand** — der Abstand, bei dem die Lautstärke ihr Minimum erreicht und nicht weiter abnimmt. Standard: 100 Welteinheiten. Bei sehr großen Werten bleibt der Klang auch in großer Entfernung noch ganz leise hörbar. Verringere den Wert, um einen Klang zu erstellen, der bei einem definierten Radius vollständig verstummt.

**Kegelinnenwinkel** — der Winkel (0 – 360°) des inneren Kegels, in dem der Klang mit voller Lautstärke spielt. Standard: 360°. Bei 360° deckt der Kegel alle Richtungen ab — der Klang ist rundum gleich laut. Verringere auf z. B. 60°, um den Klang nur direkt vor dem Knoten am lautesten zu machen. Die Ausrichtung des Knotens (über Transform eingestellt) bestimmt, welche Richtung „vorne" ist.

**Kegelaußenwinkel** — der Winkel (0 – 360°) des äußeren Kegels, jenseits dessen der Kegelaußen-Gain-Wert angewendet wird. Standard: 360°. Muss größer oder gleich dem Kegelinnenwinkel sein. Setze einen Wert größer als den Innenwinkel, um eine stufenlose Überblendzone zwischen voller und außen liegender Lautstärke zu erzeugen.

**Kegelaußen-Gain** — der Lautstärkemultiplikator für Klang, der außerhalb des äußeren Kegels gehört wird, von 0 bis 1. Standard: 0. Bei 0 ist der Klang außerhalb des Kegels vollständig still. Bei 0,5 spielt er mit halber Lautstärke außerhalb. Erhöhe leicht, wenn Hörer hinter der Quelle noch etwas hören sollen.

## Text {#text}

Ein Text-Knoten rendert eine Zeichenkette direkt in der 3D-Szene. Zwei Rendering-Engines stehen zur Verfügung; der Knoten-Typ (text_troika bzw. text_canvas) wird beim Hinzufügen des Knotens gewählt.

**Inhalt** — die anzuzeigende Zeichenkette. Bei Troika-Text ist dies Klartext. Bei Canvas-Text kann bei aktiviertem HTML erlauben HTML-Markup eingebettet werden (es wird vor dem Rendern bereinigt).

**Ausrichtung** — `Bildschirm` dreht den Text immer zur Kamera; `Welt` gibt ihm eine feste Ausrichtung im 3D-Raum (identisch mit der Billboard-Ausrichtung oben beschrieben).

**Farbe** — die Textfarbe. Klicke auf das Farbfeld, um eine Farbe zu wählen. Standard: Weiß.

**Schriftgröße** — die Größe des Texts. Bei Troika-Text in Welteinheiten (Standard: 0,2, ungefähr Beschriftungsgröße). Bei Canvas-Text in Pixeln auf dem internen Canvas (Standard: 48 px). Erhöhe den Wert, um den Text größer zu machen.

**Abstand** *(nur Canvas)* — Abstand in Pixeln zwischen dem Text und den Kanten der gerenderten Textur. Standard: 16 px. Erhöhe diesen Wert, um ein Abschneiden der Buchstaben am Rand zu verhindern.

**Breite** *(nur Canvas)* — die Breite der Ebene in Welteinheiten. Standard: 2. Passe den Wert an die Länge deines Inhalts an.

**Höhe** *(nur Canvas)* — die Höhe der Ebene in Welteinheiten. Standard: 0,5.

**HTML erlauben** *(nur Canvas)* — wenn aktiviert, wird die Inhalts-Zeichenkette als HTML geparst und erlaubt Tags wie `<b>`, `<span style="...">` oder `<img>` für eingebettete Bilder. Das HTML wird vor dem Rendern bereinigt. Standard: aus.

**Anker X** *(nur Troika)* — horizontale Ausrichtung des Textblocks relativ zur Position des Knotens: `links`, `Mitte` (Standard) oder `rechts`. Steuert, wo der Textursprung horizontal liegt.

**Anker Y** *(nur Troika)* — vertikale Ausrichtung: `oben`, `Mitte` (Standard) oder `unten`. Steuert, wo der Textursprung vertikal liegt.

**Maximale Breite** *(nur Troika)* — wenn größer als 0, werden lange Zeilen auf diese Breite in Welteinheiten umgebrochen. Standard: 0 (kein Umbruch). Setze einen Wert wie 1,5 für mehrzeilige Absätze.

## Partikel {#particles}

Die vollständige Parameterreferenz für Partikelemitter findest du unter [Partikel](topic:particles).

## Feed (szeneneigenes Overlay) {#feed}

Ein Feed-Knoten rendert Live-Daten als HTML in der 3D-Szene, angezeigt auf einer texturierten Ebene. Der Inhalt wird aktualisiert, sobald neue Daten auf dem verknüpften Datenkanal eintreffen.

**Billboard** — wenn aktiviert, dreht sich die Ebene immer zur Kamera (identisch mit Bild-Ausrichtung: Bildschirm). Standard: ein. Deaktiviere dies, um dem Feed eine feste Weltausrichtung zu geben.

**Farbe** — die Standard-Textfarbe für den Vorlageninhalt. Standard: Weiß. Kann durch CSS überschrieben werden.

**Schriftgröße** — die Basis-Schriftgröße in Pixeln, die beim Rendern der HTML-Vorlage auf den internen Canvas verwendet wird. Standard: 28 px.

**Abstand** — Abstand in Pixeln zwischen dem Inhalt und den Kanten des Canvas. Standard: 16 px.

**Breite** — die Ebenenbreite in Welteinheiten. Standard: 2.

**Höhe** — die Ebenenhöhe in Welteinheiten. Standard: 1,2.

**Vorlage** — ein HTML-Schnipsel mit `{{Feldname}}`-Platzhaltern. Wenn ein Datenereignis eintrifft, ersetzt vspark die Platzhalter durch die entsprechenden Werte und rendert den Canvas neu. Beispiel: `<div>{{username}} hat soeben abonniert!</div>`.

**CSS** — zusätzliche CSS-Regeln, die in das gerenderte Dokument eingefügt werden, begrenzt auf die Vorlagenausgabe. Nutze CSS, um Schriften, Layout, Animationen und Farben über das hinaus anzupassen, was die Farb- und Schriftgrößen-Steuerelemente oben bieten. Leer lassen, um nur die Farb- und Schriftgröße-Steuerelemente zu nutzen.

Eine vollständige Erklärung von Datenkanälen und wie Daten aus der Logik gesendet werden, findest du unter [Logik](topic:logic).
