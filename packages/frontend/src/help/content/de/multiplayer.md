# Mehrspieler-Verbindungen {#multiplayer}

Verbinde deinen vspark-Server mit dem Server einer anderen Person, um **Avatare
live zu teilen** – ihr getrackter Avatar erscheint in deiner Szene, in Echtzeit
gesteuert, ganz ohne Portfreigabe auf beiden Seiten.

Verbindungen laufen über einen kleinen öffentlichen **Rendezvous**-Server (von
deinem Host festgelegt); die eigentlichen Avatar-/Pose-Daten fließen **direkt
zwischen den beiden Servern** (peer-to-peer).

## Deine Server-ID {#identity}

Jeder Server hat eine dauerhafte **ID** (ein kryptografischer Fingerabdruck).
Damit erkennen dich Kontakte auch dann, wenn sich deine IP ändert. Du kannst sie
bedenkenlos weitergeben. Mit **Kopieren** landet sie in der Zwischenablage.

## Kopplung {#pairing}

Du koppelst dich mit jeder Person nur **einmal**; danach verbindest du dich ohne
Code wieder.

- **Code erstellen** → ein kurzer Einmal-Code. Schicke ihn der anderen Person.
- **Kopplungscode eingeben** → einen erhaltenen Code einfügen und **Beitreten**.

In beiden Fällen speichern sich beide Server gegenseitig als **Kontakte**.

## Eingehende Anfragen {#requests}

Wenn sich ein Kontakt zum ersten Mal in einer Sitzung verbindet, wirst du
gefragt, ob du **Annehmen** oder **Ablehnen** möchtest. Annehmen vertraut ihm für
den Rest der Sitzung (etwa 12 Stunden, auch über einen Neustart hinweg), sodass
erneutes Verbinden reibungslos ist. Ein manuelles **Trennen** hebt dieses
Vertrauen auf – beim nächsten Mal wird wieder gefragt.

## Kontakte {#contacts}

Deine gespeicherten Kontakte, mit einem Punkt, der anzeigt, ob du gerade
verbunden bist. **Verbinden** öffnet eine Live-Verbindung; **Trennen** schließt
sie; **✕** entfernt den Kontakt ganz (zum erneuten Verbinden ist eine neue
Kopplung nötig).

## Verbundene Mitglieder {#connected}

Alle, mit denen du gerade eine Live-Verbindung hast, erscheinen unter
**Verbunden**. Klappe den Abschnitt **Mit dir geteilt** eines Mitglieds auf, um
die Objekte zu sehen, die es dir anbietet.

## Objekte teilen {#sharing}

Teilen hat zwei Seiten:

- **Ein Objekt anbieten** – klicke mit der rechten Maustaste auf ein Objekt im
  Szenenbaum und wähle **Teilen mit**, dann ein verbundenes Mitglied (oder
  **Alle Verbundenen**). Ein Häkchen zeigt, mit wem es geteilt ist; erneutes
  Klicken hebt die Freigabe auf.
- **Ein geteiltes Objekt platzieren** – öffne die Liste **Mit dir geteilt** eines
  verbundenen Mitglieds und klicke auf **Platzieren**. Ein 📡 **Container**
  erscheint in deinem Szenenbaum und enthält sein Objekt; er folgt seinen
  Live-Änderungen. **Entfernen** nimmt ihn wieder heraus.

Das platzierte Element ist ein undurchsichtiger **Container**, der dir gehört: Du
kannst *ihn* bewegen, drehen und positionieren (das geteilte Objekt folgt, da es
darin liegt), aber sein Inhalt gehört dem Eigentümer – er erscheint nicht in
deinem Baum und du kannst ihn nicht bearbeiten. Der Inhalt ist eine Live-
**Projektion**: Er wird aus der Kopie des Eigentümers wiederhergestellt, solange
du verbunden bist, und verschwindet, wenn der Eigentümer die Freigabe beendet
oder die Verbindung trennt (der Container bleibt und füllt sich wieder, sobald er
zurück ist).

## Ein geteiltes Objekt bearbeiten {#editing}

Standardmäßig ist ein geteiltes Objekt für die Personen, mit denen du es teilst,
**schreibgeschützt**. Wenn du eines anbietest, hat das Menü **Teilen mit** einen
Schalter **Bearbeiten erlauben**: Aktiviere ihn, *bevor* du ein Mitglied
auswählst, um ihm zusätzlich zum Ansehen auch Bearbeitungsrechte zu geben.

Ein Mitglied mit Bearbeitungsrecht sieht die inneren Knoten des geteilten Objekts
in seinem eigenen Baum (nicht nur den undurchsichtigen Container) und kann sie
auswählen, bewegen, umfärben, umbenennen, **untergeordnete Objekte hinzufügen**
und **löschen**. Jede solche Änderung ist eine *Anfrage* an dich, den Eigentümer:
Sie wird zuerst auf **deine** Kopie angewendet (dein Gerät bleibt die alleinige
Quelle der Wahrheit) und dann live an alle zurückgespiegelt, die das Objekt haben
– auch an den Bearbeiter. Die Freigabe aufzuheben oder **Bearbeiten erlauben**
auszuschalten stoppt weitere Änderungen sofort.

Eine Einschränkung in dieser Version: Bearbeiter können nur **Struktur und
Eigenschaften** des Objekts ändern, aber keine **Assets** (Modelle, Bilder, Audio)
daran anhängen. Diese Dateien liegen nur auf dem Gerät des Bearbeiters, daher wird
das Ablegen eines Assets auf einem geteilten Objekt abgelehnt – füge Assets
stattdessen auf dem besitzenden Server hinzu.
