# Vorlagen {#presets}

Mit Vorlagen kannst du einen Knoten oder eine Compose-Ebene — zusammen mit
all ihren Einstellungen — als wiederverwendbaren Baustein speichern. Einmal
gespeichert, kannst du dasselbe Setup mit einem einzigen Klick in jede Szene
einfügen, ohne alles von Grund auf neu konfigurieren zu müssen.

## Was ist eine Vorlage? {#what}

Eine Vorlage ist eine Momentaufnahme eines Szene-Knotens (z. B. eines Avatars,
einer Kamera oder eines Lichts) oder einer Compose-Ebene, einschließlich ihrer
Komponenten, Animationen und Eigenschaftswerte. Stell dir eine Vorlage als
Muster vor, das du in verschiedenen Projekten wiederverwenden kannst.

vspark enthält eine Reihe von **integrierten Vorlagen** für gängige Setups. Du
kannst auch eigene Vorlagen aus allem erstellen, was du bereits in einer Szene
eingerichtet hast.

## Eine Vorlage speichern {#saving}

1. Wähle im Szene-Graphen den Knoten oder die Compose-Ebene aus, die du
   speichern möchtest.
2. Öffne das Panel **Vorlagenbibliothek** und klicke auf **Speichern**.
3. Gib der Vorlage einen Namen und optional eine Beschreibung.
4. Wenn die Vorlage auf Asset-Dateien verweist (VRM-Modelle, Audioclips,
   Bilder), aktiviere **Assets einbetten**, um sie in die Vorlage zu bündeln —
   so funktioniert sie auch, wenn sie mit anderen Projekten geteilt wird. Lasse
   die Option deaktiviert, um die Dateigröße klein zu halten, wenn du die
   Vorlage nur im selben Projekt verwendest.
5. Klicke auf **Speichern** zur Bestätigung.

Die Vorlage erscheint nun im Bereich **Projekt** der Bibliothek.

Du kannst auch auf **Kopieren** klicken, um die aktuelle Auswahl als
einmalige Übertragung in die Zwischenablage zu kopieren, ohne eine benannte
Vorlage zu speichern.

## Eine Vorlage zum Projekt hinzufügen {#using}

Um eine Vorlage in die Szene einzufügen, klicke auf **Verwenden** in der
entsprechenden Kachel der Bibliothek. vspark platziert sie:

- als neuen Knoten unterhalb des aktuell gewählten Knotens, wenn es sich um
  eine **Szene-Knoten**-Vorlage handelt.
- als neue Ebene unterhalb der aktuell gewählten Ebene, wenn es sich um eine
  **Compose**-Vorlage handelt.

Integrierte Vorlagen funktionieren genauso — klicke einfach auf **Verwenden**.

Du kannst außerdem eine `.json`-Datei **importieren**, die aus einem anderen
vspark-Projekt exportiert wurde, oder eine in die Zwischenablage kopierte
Vorlage **einfügen**.
