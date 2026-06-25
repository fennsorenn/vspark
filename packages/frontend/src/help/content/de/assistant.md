# Assistent {#assistant}

Der Assistent ist eine eingebaute KI-Hilfe, die **dein Projekt für dich bedienen**
kann. Statt dich durch Panels zu klicken, beschreibst du in normaler Sprache, was
du möchtest, und er nimmt die Änderungen vor — er erstellt Objekte, baut
2D-Overlays auf, schreibt Feed-Vorlagen und verdrahtet Logikgraphen.

Er nutzt dieselben Projektwerkzeuge wie du von Hand, sodass alles, was er tut,
live im Editor erscheint und wie jede andere Änderung bearbeitet oder rückgängig
gemacht werden kann.

## Verwendung {#how-to-use}

Klicke oben in der Leiste auf die Schaltfläche **🤖 Assistent**, um das
Chat-Fenster zu öffnen. Tippe eine Anfrage und drücke Enter. Das Fenster zeigt die
Antwort des Assistenten zusammen mit einer kurzen Spur jeder ausgeführten Aktion
(ein grünes ✓ bedeutet, dass ein Schritt erfolgreich war).

Gute Anfragen sind konkret. Zum Beispiel:

- „Füge ein Punktlicht namens Key Light hinzu, warme Farbe, recht hell."
- „Erstelle ein Chat-Overlay, das jede Nachricht in eigener Zeile in weißer
  Schrift zeigt."
- „Wenn eine Chat-Nachricht eintrifft, bewege den Hero-Avatar an eine zufällige
  Stelle."

Bei unklaren Anfragen sieht sich der Assistent zuerst das Projekt an (er listet
Szenen, Objekte oder Signalknoten-Ports auf), bevor er etwas ändert.

Mit **Unterhaltung zurücksetzen** beginnst du neu — das leert den Chat und das
Gedächtnis des Assistenten für die aktuelle Sitzung.

## Einrichtung {#setup}

Der Assistent braucht einen Sprachmodell-Endpunkt zum Denken. Er spricht das
übliche OpenAI-kompatible Chat-Protokoll und funktioniert daher mit einem lokalen
Server (etwa vLLM oder Ollama) oder einem gehosteten. Konfiguriere Endpunkt-URL,
Modellname und optionalen API-Schlüssel in den Assistenten-Einstellungen; bis
dahin zeigt das Fenster den Hinweis „nicht konfiguriert".

## Was er heute kann {#capabilities}

- Szenen-**Objekte** erstellen und konfigurieren (Avatare, Lichter, Kameras, …).
- **Compose-Overlays** und deren Ebenen aufbauen, inklusive **Feed-Vorlagen**.
- **Logikgraphen** (Signalgraphen) erstellen und **verdrahten** und dabei die
  passenden Knotenarten und Ports selbst ermitteln.

Er arbeitet immer an einem Projekt — dem gerade geöffneten.

## Grenzen & Sicherheit {#limits}

Der Assistent handelt nur auf deine Anfrage hin, und jede Änderung ist eine
normale Projektbearbeitung, die du prüfen oder rückgängig machen kannst. Er kann
sich trotzdem irren — ein kleineres Modell wählt gelegentlich einen falschen Wert
oder überspringt einen Schritt — sieh dir das Ergebnis also an, besonders bei
komplexen Logikgraphen.
