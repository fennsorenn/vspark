# Aktionen {#overview}

**Aktionen** sind fertige Automatisierungen für typische Stream-Momente — du
richtest sie über ein Formular ein, statt Knoten zu verbinden. Ein Tastenkürzel,
das einen Clip abspielt, oder eines, das ein Objekt ein- und ausblendet, ist
jeweils eine Aktion.

Aktionen gehören zum ganzen Projekt und liegen im Tab **Aktionen**. Hinter jeder
Aktion steht ein normaler [Logik](topic:logic)-Graph, den vspark aus den
Einstellungen der Aktion für dich baut — du musst ihn dir nie ansehen, kannst
ihn aber jederzeit öffnen und ändern.

## Eine Aktion hinzufügen {#add}

Klicke auf **+ Hinzufügen** und wähle eine Art. Die neue Aktion erscheint in der
Liste, gruppiert mit den anderen Aktionen derselben Art. Jede Zeile zeigt ihre
wichtigsten Einstellungen auf einen Blick — bei einem Tastenkürzel die
Tastenkombination und was sie auslöst.

- Das Kästchen am Anfang einer Zeile schaltet die Aktion ein oder aus, ohne sie
  zu löschen.
- **Einstellungen** öffnet das Formular der Aktion.
- **✕** löscht die Aktion samt Graph (**Rückgängig** holt beides zurück).

## Tastenkürzel {#hotkey}

Eine **Tastenkürzel**-Aktion reagiert auf eine Tastenkombination, die irgendwo
auf dem Rechner gedrückt wird, auf dem vspark läuft — auch wenn vspark nicht im
Vordergrund ist.

- **Kürzel**: Klicke auf die Schaltfläche und drücke die gewünschten Tasten (zum
  Beispiel `Strg + Umschalt + 1`). Mit `Esc` brichst du ab.
- **Modus**:
  - *Einfach* — jeder Druck löst dieselbe Reaktion aus.
  - *Umschalten* — Drücke wechseln zwischen zwei Reaktionen (an / aus).
  - *Durchschalten* — Drücke gehen der Reihe nach mehrere Reaktionen durch;
    **Positionen** legt fest, wie viele.
- **Reaktion** (eine pro Position): einen Clip abspielen, einen Clip erzeugen,
  einen Ausdruck setzen, eine Eigenschaft eines Objekts oder einer Ebene setzen
  oder ein Video bzw. eine Audiodatei steuern. Wähle die Reaktion und fülle dann
  ihre Details aus.

## Einstellungen, die den Graphen neu aufbauen {#value-shape}

Die meisten Einstellungen — das Kürzel, welcher Clip abgespielt wird, ein zu
setzender Wert — liest der Graph, während er läuft. Änderungen wirken sofort und
verändern den Graphen selbst nie.

Einige Einstellungen bestimmen, wie der Graph *aufgebaut* ist: der **Modus**, die
Anzahl der **Positionen** und die **Art** jeder Reaktion. Änderst du eine davon,
wird der Graph neu aufgebaut. Hast du den Graphen selbst bearbeitet, fragt
vspark vorher nach, denn der Neuaufbau verwirft diese Änderungen.

## Geändert und Vorlagen-Updates {#modified}

- **Geändert** bedeutet, dass der Graph der Aktion von Hand verändert wurde und
  nicht mehr dem entspricht, was ihre Einstellungen erzeugen würden. Knoten auf
  der Arbeitsfläche zu verschieben zählt nicht als Änderung.
- **Vorlagen-Update** bedeutet, dass eine neuere vspark-Version diese Art von
  Aktion anders erzeugt. Unveränderte Aktionen werden beim Start von vspark
  automatisch aktualisiert; geänderte behalten deine Änderungen und zeigen
  stattdessen dieses Abzeichen.

## Zurücksetzen {#reset}

**Zurücksetzen** verwirft deine Änderungen am Graphen und baut ihn aus den
aktuellen Einstellungen der Aktion neu auf. vspark fragt vorher nach.
**Rückgängig** holt den bearbeiteten Graphen zurück.

## Den Graphen öffnen {#graph}

**Graph öffnen** zeigt den Graphen der Aktion auf der Logik-Arbeitsfläche, wo du
ihn wie jede andere Logik ändern kannst — Knoten hinzufügen, neu verbinden, Werte
anpassen. Der Graph liest die Einstellungen der Aktion über
**Einstellungen**-Knoten, daher funktioniert das Formular auch weiter, nachdem
du den Graphen bearbeitet hast.
