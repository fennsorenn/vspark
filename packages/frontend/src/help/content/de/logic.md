# Logik {#logic}

Mit **Logik** kannst du Dinge automatisch als Reaktion auf Ereignisse geschehen
lassen, ohne zu programmieren. Sie ist optional — viele Setups brauchen sie nie
—, aber so baust du interaktive Momente, etwa Reaktionen auf deinen Chat oder
eine Kanal-Belohnung.

Du arbeitest mit Logik auf dem **Logik**-Tab, indem du Kästchen auf einer
Arbeitsfläche miteinander verbindest.

## Automatisierungen {#automations}

Eine **Automatisierung** ist ein einzelnes Logik-Setup: eine Arbeitsfläche aus
verbundenen Knoten, die eine Aufgabe erfüllt. Du kannst mehrere Automatisierungen
haben, von denen jede ein anderes Szenario behandelt. Automatisierungen können
zum gesamten Projekt, zu einem Szenenknoten oder zu einer Ebene gehören.

## Knoten und Verbindungen {#nodes}

![Ereignis- und Wertverbindungen](/help/diagrams/logic-wire.svg)

*Knoten werden Ausgang → Eingang verbunden. Orange Verbindungen tragen Ereignisse (ein Moment, fließt → mit dem Pfeil); blaue Verbindungen tragen Werte (Daten, die bei Bedarf gelesen werden).*

Eine Logik-Arbeitsfläche besteht aus **Knoten** (den Kästchen), die durch
**Verbindungen** (den Linien dazwischen) verknüpft sind. Jeder Knoten erledigt
eine kleine Sache — auf ein Ereignis warten, eine Zufallszahl wählen, eine
Animation abspielen —, und die Verbindungen tragen Informationen von einem Knoten
zum nächsten, von links nach rechts.

Um etwas zu bauen, ziehe Knoten aus der Palette auf die Arbeitsfläche und
verbinde einen Ausgang eines Knotens mit einem Eingang eines anderen.

## Ereignisse und Werte {#events}

Verbindungen tragen zwei Arten von Informationen:

- **Ereignisse** sind Momente — „eine Nachricht ist eingetroffen“, „der Timer
  hat ausgelöst“. Sie fließen durch den Graphen und lassen Dinge geschehen.
- **Werte** sind Daten — eine Zahl, etwas Text, ein Name. Knoten lesen Werte,
  wenn sie sie brauchen.

Übereinstimmende Farben und Formen an den Verbindungspunkten zeigen dir, was
womit verbunden werden kann.

## Stream-Auslöser {#triggers}

Logik kann auf Live-Stream-Ereignisse von verbundenen [Konten](topic:overview)
reagieren — ein neuer Follower, ein Abo, ein Chat-Befehl, eine
Kanalpunkt-Einlösung und mehr. Kombiniere einen Auslöser-Knoten mit einem
Aktions-Knoten (eine Animation abspielen, ein Overlay zeigen, einen Effekt
erzeugen), um automatische Reaktionen für dein Publikum zu erstellen.
