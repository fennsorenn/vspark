# Aktionen {#overview}

**Aktionen** sind fertige Automatisierungen für typische Stream-Momente — du
richtest sie über ein Formular ein, statt Knoten zu verbinden. Ein Tastenkürzel,
das einen Clip abspielt, ein Chat-Befehl, der mit einem Zähler antwortet, oder
eine Emote-Combo, die eine Animation startet, ist jeweils eine Aktion.

Aktionen gehören zum ganzen Projekt und liegen im Tab **Aktionen**. Hinter jeder
Aktion steht ein normaler [Logik](topic:logic)-Graph, den vspark aus den
Einstellungen der Aktion für dich baut — du musst ihn dir nie ansehen, kannst
ihn aber jederzeit öffnen und ändern.

## Eine Aktion hinzufügen {#add}

Klicke auf **+ Hinzufügen** und wähle eine Art. Die neue Aktion erscheint in der
Liste, gruppiert mit den anderen Aktionen derselben Art. Jede Zeile zeigt ihre
wichtigsten Einstellungen auf einen Blick — bei einem Tastenkürzel die
Tastenkombination und was sie auslöst.

- Klicke auf eine Zeile, um die Aktion zu bearbeiten: Ihre Einstellungen öffnen
  sich im Hauptbereich neben der Liste (eine neue Aktion öffnet sich dort
  sofort).
- Das Kästchen am Anfang einer Zeile schaltet die Aktion ein oder aus, ohne sie
  zu löschen.
- Das **+** neben dem Namen einer Gruppe fügt mit einem Klick eine weitere
  Aktion dieser Art hinzu.
- **Aktion löschen** (unten in den Einstellungen) löscht die Aktion samt Graph
  (**Rückgängig** holt beides zurück).

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

## Chat-Befehl {#chat_command}

Ein **Chat-Befehl** antwortet, wenn jemand einen Befehl wie `!hug` in deinen
Chat (Twitch) schreibt.

- **Befehl** und **Aliase**: der Name des Befehls (mit oder ohne `!`) und
  weitere Namen, die dasselbe tun, durch Leerzeichen oder Kommas getrennt —
  `!hug` mit den Aliasen `cuddle snuggle` reagiert auch auf `!cuddle` und
  `!snuggle`. Groß- und Kleinschreibung spielen keine Rolle.
- **Wer darf ihn nutzen**: alle oder nur Abonnenten, Moderatoren oder der
  Kanalinhaber (jeder Rang schließt die höheren ein).
- **Abklingzeit**: siehe [Abklingzeit](#cooldown).
- **Argumente müssen passen** (optional): ein [Muster](#patterns), zu dem der
  Text nach dem Befehl passen muss, zum Beispiel `^@?(?<target>\w+)$` für „genau
  ein Name“. Passt er nicht, passiert nichts. Benannte Gruppen werden zu
  [Platzhaltern](#placeholders) für die Antwort.
- **Zähler** (optional): siehe [Zähler](#counter).
- **Antwort**: die Chat-Nachricht, die zurückgeschickt wird, mit den
  [Platzhaltern](#placeholders) `${user}`, `${args}` und `${count}`. Leer lassen,
  um nichts zu senden.

Beispiel: Befehl `!hug`, Antwort `${user} umarmt ${args}! (schon ${count} Umarmungen)`.

## Chat-Muster {#chat_pattern}

Ein **Chat-Muster** funktioniert wie ein Chat-Befehl, reagiert aber auf jede
Chat-Nachricht, deren *gesamter* Text zu einem [Muster](#patterns) passt.
Benannte Gruppen im Muster werden zu [Platzhaltern](#placeholders) für die
Antwort, neben `${user}`, `${message}` und `${count}`.

Beispiel: Das Muster `"(?<quote>.+)" - (?<who>[^.]+)\. (?<year>\d{4})` passt zu
`"I'll be back" - Terminator. 1984`, und die Antwort kann `${quote}`, `${who}`
und `${year}` verwenden.

## Chat-Stichwort {#chat_keyword}

Ein **Chat-Stichwort** reagiert, wenn eines seiner Stichwörter oder Emote-Namen
irgendwo in einer Chat-Nachricht vorkommt — als ganzes Wort, ohne auf Groß- und
Kleinschreibung zu achten (`LUL` passt zu „haha lul!“, aber nicht zu „LULZ“).

- **Stichwörter**: Wörter, Wortgruppen oder Emote-Namen, durch Kommas getrennt.
- **Abklingzeit**: siehe [Abklingzeit](#cooldown).
- **Reaktion**: was passiert — einen Clip abspielen, einen Ausdruck oder eine
  Eigenschaft setzen, ein Video oder eine Audiodatei steuern (für einen
  Soundeffekt *Medien steuern*, das Audio-Objekt bzw. die Ebene und *Abspielen*
  wählen) oder *Keine Reaktion*.
- **Auslöser senden** (optional): siehe [Auslöser](#trigger).

## Stichwort-Combo {#keyword_combo}

Eine **Stichwort-Combo** reagiert, wenn ein Stichwort oder Emote gespammt wird:
Sie zählt die Chat-Nachrichten, die es enthalten, solange jede neue Nachricht
**innerhalb** der angegebenen Sekunden nach der vorigen kommt. Kommt so lange
keine Nachricht, endet die Combo, und das Zählen beginnt von vorn.

- Der **Modus** bestimmt, wann die Reaktion läuft:
  - **Bei Schwelle**: sobald die Zahl die **Schwelle** erreicht.
  - **Nach Ablauf**: wenn die Combo endet, sofern die Zahl bis dahin die
    **Schwelle** erreicht hat — die Reaktion kommt also, nachdem der Spam
    abgeklungen ist, und die Abschlussnachricht kann die Endzahl nennen.

  Ein Wechsel des Modus baut den Graphen der Aktion neu auf (siehe
  [Einstellungen, die den Graphen neu aufbauen](#value-shape)).
- **Jeden Chatter nur einmal zählen**: Wer das Stichwort wiederholt, zählt weder
  erneut, noch hält er die Combo am Leben. Ausschalten, um jede Nachricht zu
  zählen.
- **Bei Erreichen** / **Bei Ende**: die Reaktion, die einmal pro Combo
  ausgeführt wird.
- **Abschlussnachricht** (optional): eine Chat-Nachricht, die gesendet wird,
  wenn eine Combo endet, die die Schwelle erreicht hat, mit `${count}` für die
  Endzahl.

## Einlösung {#redemption}

Eine **Einlösung** reagiert, wenn ein Zuschauer eine deiner
Kanalpunkte-Belohnungen einlöst.

- **Belohnung**: der Titel der Belohnung, genau wie auf Twitch (Groß- und
  Kleinschreibung spielen keine Rolle).
- **Reaktion**: was beim Einlösen passiert.
- **Zähler** (optional): siehe [Zähler](#counter).
- **Antwort** (optional): eine Chat-Nachricht mit `${user}`, `${message}` (dem
  Text, den der Zuschauer eingegeben hat), `${reward}` und `${count}`.
- **Auslöser senden** (optional): sendet einen Auslöser mit den Details der
  Einlösung (Zuschauer, Belohnung, Nachricht, …) — siehe [Auslöser](#trigger).
- **Einlösung als erledigt markieren**: markiert sie auf Twitch als erfüllt,
  sodass sie aus deiner Belohnungs-Warteschlange verschwindet. Dafür braucht das
  Konto die Berechtigung, Einlösungen zu verwalten, und es klappt nur bei
  Belohnungen, die mit derselben App erstellt wurden.

## Platzhalter {#placeholders}

Antworten und Nachrichten können Platzhalter der Form `${name}` enthalten, die
beim Senden ersetzt werden:

| Platzhalter | Bedeutung |
|---|---|
| `${user}` | Der Anzeigename des Chatters bzw. Zuschauers |
| `${args}` | Alles nach dem Befehl (Chat-Befehl) |
| `${message}` | Die Chat-Nachricht bzw. der bei einer Einlösung eingegebene Text |
| `${reward}` | Der Titel der Belohnung (Einlösung) |
| `${count}` | Der Stand des Zählers nach dem Zählen (siehe [Zähler](#counter)) bzw. die Endzahl einer Combo |
| `${…}` | Jede *benannte Gruppe* eines Musters, z. B. `${quote}` für `(?<quote>…)` |

Ein Platzhalter ohne Wert bleibt leer.

## Muster {#patterns}

Muster sind *reguläre Ausdrücke* — eine kompakte Art, Text zu beschreiben. Mit
ein paar Bausteinen kommt man weit:

- `.` ein beliebiges Zeichen, `\d` eine Ziffer, `\w` ein Buchstabe, eine Ziffer
  oder ein Unterstrich, `\s` ein Leerzeichen;
- `+` „ein oder mehr“, `*` „beliebig viele“, `?` „optional“;
- `^` der Anfang und `$` das Ende des Texts;
- `(?<name>…)` eine *benannte Gruppe*: Was sie erfasst, wird zum Platzhalter
  `${name}`.

Groß- und Kleinschreibung werden ignoriert. Ein ungültiges Muster passt nie.

## Abklingzeit {#cooldown}

Die **Abklingzeit** ist die Anzahl Sekunden, die die Aktion nach dem Auslösen
wartet, bevor sie wieder reagiert; `0` schaltet sie ab. Nutzungen während der
Abklingzeit werden ignoriert.

Gib mehreren Aktionen denselben Namen als **geteilte Gruppe**, dann teilen sie
sich eine Abklingzeit: Nachdem eine von ihnen ausgelöst hat, warten alle. Ohne
Gruppe hat jede Aktion ihre eigene Abklingzeit.

## Zähler {#counter}

Mit **Jede Nutzung zählen** zählt die Aktion, wie oft sie ausgelöst hat, und
`${count}` in der Antwort zeigt die Zahl. **Schrittweite** ist, wie viel jede
Nutzung hinzufügt.

- Ohne Namen gehört der Zähler nur dieser Aktion.
- Mit Namen ist er ein geteilter Zähler: Aktionen mit demselben Namen zählen
  gemeinsam, und jede Logik kann ihn mit einem **Get Variable**-Knoten lesen.
- **Nach Neustart behalten** speichert den Zähler, sodass er einen Neustart von
  vspark übersteht.

## Konto {#account}

Chat- und Einlösungs-Aktionen lesen mit — und antworten — über ein
Streaming-**Konto** aus den Konten des Projekts (**Konten** in der
Werkzeugleiste). *Standardkonto* ist das Standardkonto des Projekts; wähle ein
anderes, wenn du mehrere hast.

## Auslöser {#trigger}

**Auslöser senden** sendet bei jedem Auslösen der Aktion einen benannten
*Auslöser*. Jeder [Logik](topic:logic)-Graph im Projekt kann mit einem
**On Trigger**-Knoten desselben Namens darauf reagieren — zum Beispiel, um einen
Alert anzuzeigen. Leer lassen, um nichts zu senden.

## Einstellungen, die den Graphen neu aufbauen {#value-shape}

Die meisten Einstellungen — das Kürzel, welcher Clip abgespielt wird, ein zu
setzender Wert — liest der Graph, während er läuft. Änderungen wirken sofort und
verändern den Graphen selbst nie.

Einige Einstellungen bestimmen, wie der Graph *aufgebaut* ist: der **Modus** und
die Anzahl der **Positionen** eines Tastenkürzels, der **Modus** einer
Stichwort-Combo sowie die **Art** jeder
Reaktion (bei jeder Art von Aktion, die eine hat). Änderst du eine davon,
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
du den Graphen bearbeitet hast. Der Tab Logik listet die Graphen aller Aktionen
in einem eigenen Abschnitt **Aktionslogik**.
