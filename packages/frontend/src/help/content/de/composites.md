# Widgets {#composites}

Ein **Widget** ist ein fertiges Overlay – ein Alert, ein Chat-Overlay –, das
als **ein Objekt mit eigenen Einstellungen** eingefügt wird. Statt dich durch
Ebenen, einen Track-Clip und einen Logik-Graphen zu suchen, um die Nachricht oder
den Ton zu ändern, stellst du beides direkt am Widget ein.

Widgets stehen in der Palette **Erstellen** neben den normalen Objekten und
Ebenen und tragen ein kleines Kennzeichen **Widget**. Dasselbe Kennzeichen
erscheint an ihrer Zeile im Szenen- oder Kompositionsbaum.

## Einstellungen {#settings}

Wähle ein Widget aus, um seine **Einstellungen** im Eigenschaften-Bereich zu
sehen. Jede Einstellung schreibt direkt in die Teile des Widgets – eine
getrennte Kopie des Werts gibt es nicht. Du kannst die Teile also auch direkt
bearbeiten (die Nachricht verschieben, ihr eine andere Schriftart geben), und die
Einstellung zeigt die Änderung.

Jede Änderung ist ein Rückgängig-Schritt. Zeigt eine Einstellung auf etwas, das
du aus der Logik des Widgets entfernt hast, steht dort _nicht verfügbar_.

## Alert {#alert}

Ein Alert zeigt bei einem Ereignis ein Bild, eine Nachricht und einen Ton und
blendet dann wieder aus. Alerts, die gleichzeitig ankommen, warten in einer
Warteschlange und laufen nacheinander.

- **Auslöser** – was den Alert zeigt: eine **Spende**, ein **Trinkgeld**, ein
  **Abo** oder ein **Raid** auf deinem verbundenen Konto, oder ein **Benannter
  Auslöser**. Den sendet die Option _Auslöser senden_ einer Aktion oder ein
  Knoten _Send Trigger_ in einem beliebigen Logik-Graphen; trage hier denselben
  **Namen des Auslösers** ein.
- **Nachricht** – der Text, mit Platzhaltern wie `${displayName}`, die aus dem
  Ereignis gefüllt werden (bei einem Raid auch `${viewerCount}`; bei einem
  benannten Auslöser jedes Feld dessen, was mitgeschickt wurde, oder
  `${payload}` für reinen Text).
- **Bildart** – ein festes **Bild** oder ein **Video**, und welches gezeigt wird.
- **Ton** und **Lautstärke** – werden bei jedem Alert abgespielt.
- **Anzeigedauer** – wie lange der Alert zu sehen ist, Ein- und Ausblenden
  eingeschlossen.
- **Abstand** – wie lange die Warteschlange bis zum nächsten Alert wartet.

## Chat-Overlays {#chat}

- **Chat-Overlay** (2D) und **Chat-Overlay (3D)** zeigen die neuesten
  Chatnachrichten eines Kontos. Stelle das **Konto**, die Zahl der **angezeigten
  Nachrichten** sowie **Schriftart**, **Schriftgröße**, **Textfarbe** und
  **Blasenfarbe** ein.
- **Laufender Chat (3D)** lässt jede Nachricht quer durch die Szene fliegen.
  Stelle die **Durchlaufzeit** und den Bereich der Höhen und Tiefen ein, in denen
  die Nachrichten fliegen.

## Teile bleiben an ihrem Platz {#parts}

Die Objekte in einem Widget sind seine **Teile**. Du kannst sie wie jedes
andere Objekt auswählen, bearbeiten und umsortieren, aber nicht aus dem
Widget heraus oder in eine Gruppe darin verschieben und auch nicht einzeln
löschen: Die Logik des Widgets spricht sie an genau dieser Stelle an. Löschst
du das ganze Widget, verschwinden seine Teile mit ihm.

## Auflösen {#dissolve}

**Widget auflösen** (im Abschnitt Einstellungen und im Rechtsklickmenü des
Baums) macht aus einem Widget eine normale Gruppe. Darin ändert sich nichts,
aber die Einstellungen verschwinden und die Teile lassen sich frei verschieben
und löschen – für den Fall, dass du mehr anpassen willst, als die Einstellungen
erlauben. Auflösen lässt sich rückgängig machen.
