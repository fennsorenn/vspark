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

- **Auslöser** – was den Alert zeigt: eine **Spende**, ein **Trinkgeld**,
  **Bits**, ein **Abo**, **verschenkte Abos**, ein **Follow** oder ein **Raid**
  auf deinem verbundenen Konto, oder ein **Benannter Auslöser**. Den sendet die Option _Auslöser senden_ einer Aktion oder ein
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

## Stream-Widgets {#widgets}

Zielbalken, Timer und Ereignislisten für dein Overlay. Es sind 2D-Ebenen; jede
zeigt ihre Daten auf der Seite an und aktualisiert sich nur, wenn sich etwas
ändert.

### Ziel {#goal}

Ein Balken, der sich bis zu einem Zielwert füllt.

- **Ziel aus** – das **Twitch-Ziel** des Kanals (welche Art, wählst du unter
  **Twitch-Ziel**) oder ein **Eigenes Ziel** mit **Beschriftung** und
  **Zielwert**.
- Bei einem eigenen Ziel legt **Zählt** fest, welches Ereignis es voranbringt
  (Follows, Abos, verschenkte Abos, Bits, der Trinkgeldbetrag, Raid-Zuschauer
  oder ein benannter Auslöser) – oder _Nichts_, um es nur von Hand zu setzen.
  **Aktueller Stand** setzt es jederzeit von Hand.
- Der Stand liegt in einer Projekt-**Variable** (`goal`, wenn du sie nicht
  umbenennst), also können auch Aktionen und andere Logik ihn ändern.
- **Behalten** – den Stand beim Streamstart zurücksetzen (**Dieser Stream**)
  oder weiterzählen (**Über Streams hinweg**).

Twitch-Ziele brauchen die Freigabe für Ziele auf deinem Konto: Erscheint ein
Twitch-Ziel nicht, verbinde das Konto einmal neu.

### Countdown {#countdown}

Ein Timer, der **eine feste Dauer** oder **bis zu einer Uhrzeit** (etwa `20:00`)
herunterzählt. Nutze **Starten**, **Pausieren**, **Fortsetzen** und
**Zurücksetzen** in seinen Einstellungen. Dieselben Aktionen sind benannte
Auslöser – `countdown start`, `countdown pause`, … (den Grundnamen änderst du
unter **Namen der Auslöser**) –, sodass Aktionen, Tastenkürzel und andere Logik
ihn steuern können. **Bei null Auslöser senden** sendet einen benannten Auslöser,
wenn er abläuft, etwa um die Szene zu wechseln oder einen Alert zu zeigen.

Ein laufender Timer läuft nach einem Neustart von vspark weiter.

### Subathon-Timer {#subathon}

Ein Timer, dem Unterstützung Zeit hinzufügt.

- **Startzeit** – worauf **Starten** den Timer setzt.
- **Zeit pro** – wie viel Zeit ein Abo, ein verschenktes Abo, 100 Bits, eine
  Währungseinheit Trinkgeld oder ein Follow hinzufügt. Verschenkte Abos zählen
  einmal pro verschenktem Abo, nicht noch einmal als Abo.
- **Harte Grenze** – die größte Gesamtdauer (Startzeit plus alles
  Hinzugefügte), die der Timer erreichen kann; `0` heißt ohne Grenze.
- **Stufen der weichen Grenze** – ab einer Gesamtdauer zählt jede weitere Zeit
  weniger, zum Beispiel ab 12 Stunden ×0,5 und ab 24 Stunden ×0,25. Trage den
  **Geplanten Start** ein, um zu sehen, welcher Endzeit jede Stufe entspricht –
  der Timer erreicht eine Stufe, wenn er zu dieser Zeit enden würde.

Gesteuert wird er wie der Countdown (`subathon start`, `subathon pause`, …).

### Letzte Ereignisse {#recent}

Die neuesten Follows, Abos, verschenkten Abos, Bits, Trinkgelder und Raids, das
neueste zuerst. Schalte jede Art an oder aus, ändere den Text dazu und wie viele
**Einträge** angezeigt werden. **Behalten** leert die Liste beim Streamstart oder
behält sie über Streams hinweg.

### Top-Unterstützer {#top}

Eine Bestenliste, wer am meisten gegeben hat – **Sortiert nach** Bits,
Trinkgeld, verschenkten Abos, Abos oder Raid-Zuschauern – für **Dieser Stream**
oder **Über Streams hinweg**.

### Werbepause {#adbreak}

Erscheint, während eine Werbepause läuft, mit deiner **Nachricht** und der Zeit
bis zu ihrem Ende, und verschwindet danach wieder.

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
