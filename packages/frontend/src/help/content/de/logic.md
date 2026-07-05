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

Logik kann auch antworten: Die Aktion **Chat senden** postet beim Auslösen eine
Nachricht in deinen Kanal. Ihre Nachricht ist eine Vorlage — schreibe festen
Text gemischt mit `${Platzhaltern}` und verbinde dann einen Wert mit jedem
benannten Eingang, um die Lücken zu füllen (zum Beispiel einen neuen Follower
mit Namen begrüßen). Zum Senden muss das Konto einmal neu verbunden werden,
damit es die Berechtigung zum Schreiben im Chat erteilt.

## System-Tastenkürzel {#hotkeys}

Der Auslöser **System-Tastenkürzel** reagiert, wenn du irgendwo auf dem
Computer, auf dem vspark läuft, eine Tastenkombination drückst — auch wenn
vspark im Hintergrund ist und eine andere App im Vordergrund läuft. Ideal für
freihändige Momente während des Streamens: per Tastendruck eine Animation
abspielen, einen Ausdruck wechseln oder ein Overlay einblenden.

Lege die **Taste** fest (ihren Namen, z. B. `F8`, `A` oder `SPACE`) und setze
bei Bedarf die Häkchen für die Zusatztasten — **ctrl**, **shift**, **alt**,
**meta** (die Windows-/Command-Taste). Die Übereinstimmung ist exakt: Ein
Kürzel `Strg + S` löst nicht bei `Strg + Umschalt + S` aus. Verbinde den
Ereignisausgang des Knotens mit einer Aktion, um darauf zu reagieren.

Da die Tastatur systemweit überwacht wird, funktioniert dies nur, wenn der
Server auf deinem eigenen Rechner läuft. Auf einem Headless- oder
Remote-Server oder dort, wo das Betriebssystem globale Tastatur-Hooks
blockiert, löst das Kürzel einfach nie aus — sonst wird nichts beeinträchtigt.

## Makros {#macros}

Der **Makros**-Tab ist der einfache Weg, um eine ganze Reihe von Tastenkürzeln
einzurichten, ohne die Knoten-Leinwand anzufassen. Jedes Makro liest sich wie
ein Satz: *Wenn ich [Kürzel] drücke → [Aktion ausführen]*.

- Klicke auf **Makro hinzufügen**, dann auf die Kürzel-Schaltfläche und drücke
  die gewünschten Tasten (z. B. `Strg + Umschalt + 1`). Wähle eine Aktion —
  einen Clip abspielen, einen Ausdruck setzen, etwas ein- oder ausblenden, ein
  Video steuern — und fülle die Details aus.
- Das Kontrollkästchen **An** aktiviert oder deaktiviert ein Makro, ohne es zu
  löschen.

Makros sind nur eine benutzerfreundliche Ansicht der Logik: Jedes ist im
Hintergrund eigentlich ein *System-Tastenkürzel*-Knoten, der mit einem
Aktions-Knoten verbunden ist. Alles, was du auf der Leinwand baust und mit
einem Tastenkürzel beginnt, erscheint also auch hier, und Änderungen bleiben in
beide Richtungen synchron. Wenn ein Makro etwas tut, das die einfache Ansicht
nicht darstellen kann — ein Umschalten oder eine handverdrahtete Kette — zeigt
die Zeile das an und bietet **Im Graph öffnen**, um es mit voller Kontrolle zu
bearbeiten.
