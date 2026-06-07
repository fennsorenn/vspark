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
