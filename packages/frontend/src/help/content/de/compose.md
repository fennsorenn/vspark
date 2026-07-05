# Compose {#compose}

**Compose** ist die 2D-Layout-Ansicht für deinen Stream. Während die
[Szene](topic:scene) deine 3D-Welt verwaltet — Avatar, Lichter, Kameras —
ermöglicht Compose das Platzieren flacher Ebenen vor oder hinter dem 3D-Bild,
um das endgültige Aussehen für deine Zuschauer zu gestalten. Stell es dir wie
einen Stapel transparenter Folien vor, die vor deiner Kamera liegen.

## Übersicht {#overview}

Öffne den **Compose**-Tab, um den Ebenenbaum links und eine Echtzeit-Vorschau
der Ausgabe in der Mitte zu sehen. Jede **Compose-Szene** ist ein benanntes
Layout, zwischen dem du wechseln kannst — zum Beispiel ein Layout für die
Gesichtskamera und ein anderes für eine Ganzkörperaufnahme. Ebenen innerhalb
einer Szene stapeln sich übereinander; die Reihenfolge bestimmt, was vorne
erscheint.

## Ebenen {#layers}

Eine Ebene ist ein einzelnes flaches Element in deiner Compose-Szene. Es gibt
vier Arten:

- **Bild** — ein Standbild aus deinen Assets. Verwende es für Rahmen, Logos
  oder andere statische Grafiken, die über dem 3D-Bild liegen.
- **Video** — eine Videodatei, die im Layout abgespielt wird. Unterstützt
  Autostart, Wiederholen und Chroma-Key (Greenscreen-Entfernung).
- **Browserquelle** — eine Live-Webseite, die innerhalb einer Ebene dargestellt
  wird. Nützlich für Benachrichtigungsboxen, Spendenanzeigen oder webbasierte
  Overlay-Tools.
- **Vorlage / Feed** — eine dynamische Ebene, die durch Daten aus deinem Stream
  gespeist wird (siehe [Feed-Ebenen](#feed) unten).

Wähle eine Ebene im Baum aus, um ihre Einstellungen im Eigenschaften-Bereich
rechts zu bearbeiten.

## Reihenfolge der Ebenen {#ordering}

![Stapelreihenfolge der Ebenen](/help/diagrams/compose-order.svg)

_Ebenen werden relativ zum Betrachter rechts vor oder hinter dem 3D-Bild (hervorgehoben) gestapelt._

Ebenen sind von oben (vorne) nach unten (hinten) angeordnet. Ziehe eine Ebene
**zwischen** zwei Zeilen (oder an den Anfang bzw. das Ende einer Ebene), um sie
dort umzusortieren, oder lasse sie **auf** einer anderen Ebene fallen, um sie als
Unterebene zu verschachteln — eine blaue Linie zeigt das Umsortieren, eine
hervorgehobene Zeile das Verschachteln. Lasse sie auf dem leeren Bereich einer
Compose-Szene fallen, um eine Ebene zurück auf deren oberste Ebene zu verschieben,
oder auf eine **andere** Compose-Szene, um sie dorthin zu verschieben. Halte beim
Loslassen **Strg** (**⌘** auf dem Mac) gedrückt, um statt des Verschiebens eine
**Kopie** abzulegen. Zusätzlich hat jede Ebene eine **Stapelreihenfolge**, die
steuert, ob sie vor oder hinter der 3D-Szene erscheint:

- Eine negative Stapelreihenfolge platziert die Ebene **vor** dem 3D-Bild.
- Null platziert sie auf derselben Ebene wie die 3D-Szene.
- Eine positive Stapelreihenfolge schiebt die Ebene **hinter** das 3D-Bild.

Ebenen können auch einen Geltungsbereich haben: Eine **szenenweit** gültige
Ebene erscheint bei jeder Kamera, während eine **Kamera**-Ebene auf eine
bestimmte [Kamera](topic:scene#cameras) begrenzt ist und nur erscheint, wenn
diese Kamera aktiv ist.

## Ebenen positionieren {#positioning}

Wähle eine Ebene aus und verwende den **Eigenschaften**-Bereich, um Position,
Größe und Drehung festzulegen. Alle Werte sind standardmäßig in Pixel, du
kannst aber auf Prozentangaben umstellen, damit sich die Ebene an die
Ausgabeauflösung anpasst.

Der **Ankerpunkt** legt fest, welche Ecke oder Kante der Ebene als Referenzpunkt
für die eingegebene Position gilt. Wenn du beispielsweise den Ankerpunkt auf die
untere rechte Ecke setzt und X/Y auf null stellst, rastet die Ebene an der
unteren rechten Ecke des Ausgabebereichs ein.

Wenn du eine Ebene in der Vorschau ziehst **oder ihre Größe änderst**, **rastet**
sie an der Mitte und den Kanten ihres übergeordneten Elements ein (bei einer Ebene
der obersten Ebene die gesamte Leinwand): Die Kanten und die Mitte der Ebene — oder
die Kante, deren Größe du änderst — ziehen sich zu den Kanten und der Mitte des
übergeordneten Elements, und eine rosa Hilfslinie zeigt jede aktive Einrastung.
Halte beim Ziehen **Alt** gedrückt, um frei ohne Einrasten zu verschieben, oder
schalte das Einrasten mit der Magnet-Schaltfläche in der Compose-Symbolleiste
(oben rechts) ganz aus.

Du kannst eine Ebene in 2D sperren, damit sie in der Vorschau nicht versehentlich
verschoben wird, oder die 3D-Interaktion sperren, falls sie den 3D-Viewport
überlappt.

Wenn eine Bild- oder Videoebene eine **Kameraansicht**-Ebene überlappt, bietet ein
Rechtsklick darauf (in der Ebenenliste **oder** in der Vorschau) **In 3D senden**:
Dadurch wird ein passendes Billboard (oder eine Videoebene) in der 3D-Szene dieser
Kamera erstellt — so positioniert und skaliert, dass es genau dort sitzt, wo die
2D-Ebene in der Kameraansicht lag — und die flache 2D-Ebene anschließend entfernt;
das neue 3D-Objekt erscheint an ihrer Stelle durch die Kameraansicht. Praktisch, um
ein flaches Overlay in die 3D-Szene zu übernehmen, wo es wie jedes andere Objekt
verschachtelt, animiert oder beleuchtet werden kann. Du bleibst in der Compose-Ansicht.

## An einen Knochen anheften {#attach-bone}

Innerhalb einer **Kameraansicht**-Ebene kannst du die dort gezeigten 3D-Objekte
ziehen. Aktiviere den **Anheften-Modus** über die Knochen-Schaltfläche neben dem
Einrasten-Umschalter in der Compose-Werkzeugleiste (oder halte beim Ziehen die
**Umschalttaste**), ziehe dann ein Objekt auf ein Modell und lasse es über dem
gewünschten Körperteil los. Das Objekt bindet sich an den Knochen, der diesen Teil
steuert — den mit dem stärksten Einfluss dort — lege es also auf eine Hand, folgt es
der Hand; lege es auf den Kopf, folgt es dem Kopf. Seine Bildschirmposition bleibt
erhalten, und ab da wird seine Transformation relativ zu diesem Knochen gemessen.
Lasse es frei von jedem Modell los, kehrt es auf die oberste Ebene der Szene zurück
und behält dabei seine Position. So bekommst du am schnellsten ein Schwert in die
Hand oder einen Hut auf den Kopf, ohne den Szenenbaum zu durchsuchen.

## Vorlage / Feed-Ebenen {#feed}

Eine **Vorlage**-Ebene ist eine live-datengesteuerte Ebene. Sie verwendet einen
kleinen Markup-Ausschnitt (JSX-ähnliche htm-Syntax), der auf Daten verweisen
kann, die von deinem Logikgraph veröffentlicht werden — zum Beispiel eine laufende
Liste von Chat-Nachrichten, eine Abonnenten-Benachrichtigung oder ein aktueller
Songname.

Du musst keinen Code schreiben, um grundlegende Vorlagen zu verwenden: Die
eingebauten Vorlagen decken gängige Anwendungsfälle wie Chat-Overlays und
Benachrichtigungsboxen ab. Für individuelle Layouts akzeptiert das Vorlagenfeld
Standard-HTML-Elemente und kann auf jedes Feld verweisen, das ein
**set_data**-Knoten in den Geltungsbereich der Ebene veröffentlicht.

Statische visuelle Stile können im Feld **Stile (CSS)** hinzugefügt werden;
dynamische Stile (Farben oder Größen, die sich mit den Daten ändern) werden direkt
im Vorlagen-Markup selbst inline angegeben.
