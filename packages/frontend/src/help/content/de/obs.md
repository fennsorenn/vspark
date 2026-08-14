# OBS-Integration {#obs}

Wenn du vspark in OBS als **Browserquelle** einbindest, kann vspark sowohl
*auf* OBS reagieren als auch OBS *steuern* — alles über den **Logik**-Tab.
Ohne Plugins, Passwörter oder zusätzliche Einrichtung: Sobald vspark in einer
OBS-Browserquelle läuft, funktionieren diese Knoten.

## Wie es funktioniert {#how}

OBS stellt der Webseite innerhalb einer Browserquelle eine kleine
Steuerschnittstelle bereit. vspark verbindet diese Schnittstelle mit deinem
Logik-Graphen: OBS-Ereignisse werden zu Knoten, aus denen du Automationen
auslösen kannst, und einige Aktionsknoten lassen dich OBS Anweisungen geben.
Alles ist auf dein Projekt beschränkt, sodass mehrere Browserquellen synchron
bleiben, ohne deine Automationen doppelt auszulösen.

## Auf OBS reagieren {#events}

Diese Knoten lösen aus, wenn sich in OBS etwas ändert:

- **OBS Szene gewechselt** — löst aus, wenn du die aktive Szene wechselst. Gibt
  den Namen der neuen Szene und die Leinwandgröße aus. Trage einen Szenennamen
  im Knoten ein, um nur auf diese Szene zu reagieren.
- **OBS Ausgabestatus** — löst aus, wenn Streaming, Aufnahme, der
  Wiederholungspuffer oder die virtuelle Kamera startet oder stoppt. Gibt aus,
  welche Ausgabe sich geändert hat, den Übergang (gestartet / gestoppt /
  pausiert / gespeichert …) und ob sie jetzt aktiv ist. Ein gespeicherter
  Wiederholungs-Clip ist ein guter Auslöser für eine Jubel-Animation.

## OBS steuern {#actions}

Diese Knoten weisen OBS an, beim Auslösen etwas zu tun:

- **OBS Szene setzen** — die aktive Programmszene per Namen wechseln. Dieser
  Knoten läuft über **obs-websocket** (siehe unten) und benötigt daher eine
  OBS-Verbindung unter **Konten → OBS-Verbindungen** — dafür kein Hantieren mit
  Seitenberechtigungen, und er meldet, wenn etwas schiefgeht.
- **OBS Übergang setzen** — den aktiven Szenenübergang per Namen wechseln.
- **OBS Steuerung** — Streaming, Aufnahme (samt Pause/Fortsetzen), den
  Wiederholungspuffer (einschließlich *Speichern*) oder die virtuelle Kamera
  starten/stoppen.

> **Berechtigungen.** Außer bei *OBS Szene setzen* funktionieren
> Steuerungsaktionen nur, wenn die **Seitenberechtigungen** der Browserquelle
> (in deren OBS-Eigenschaften) hoch genug sind — „Erweitert" für
> Übergangswechsel, „Alle" für die Steuerung von Streaming/Aufnahme/virtueller
> Kamera. OBS ignoriert Aktionen oberhalb der gewährten Stufe stillschweigend;
> wenn ein Steuerungsknoten also nichts zu bewirken scheint, erhöhe die
> Berechtigungsstufe.

## Tiefere Steuerung mit obs-websocket {#obs-websocket}

Die obigen Knoten nutzen die eingebaute Browser-API von OBS, die kein Audio
steuern kann. Dafür — und für mehr — kann sich vspark zusätzlich über
**obs-websocket** mit OBS verbinden, einen zweiten, optionalen Kanal, den du in
OBS unter **Werkzeuge → WebSocket-Servereinstellungen** aktivierst. Übertrage
den dort angezeigten **Server-Port** und das **Server-Passwort** in vspark unter
**Konten → OBS-Verbindungen**. Da vspark auf demselben Rechner wie OBS läuft,
bleibt der Host `localhost`.

Nach dem Verbinden werden zusätzliche Knoten verfügbar:

- **OBS Lautstärke setzen** / **OBS Stumm** — die Lautstärke eines Audio-Eingangs
  setzen (in dB oder als linearer Multiplikator) oder ihn stummschalten /
  aufheben / umschalten. Ideal, um bei einer Spende die Musik abzusenken, oder
  für eine Boss-Key-Stummschaltung.
- **OBS Lautstärke geändert** / **OBS Stummschaltung geändert** — reagieren, wenn
  du einen Regler bewegst oder eine Quelle stummschaltest.
- **OBS Wiederholungspfad** — den Dateipfad des zuletzt gespeicherten
  Wiederholungs-Clips abrufen (die Browser-API meldet nur, *dass* ein Clip
  gespeichert wurde, nicht *wo*).
- **OBS Verbindungsstatus** — reagieren, wenn die OBS-Verbindung auf- oder
  abgebaut wird.

Die Verbindung liegt im Backend und stellt sich automatisch wieder her. Ihr
Status wird als Punkt neben der Verbindung im Konten-Panel angezeigt.

## Auf erscheinende Clients reagieren {#lifecycle}

Der Knoten **Client-Lebenszyklus** löst aus, wenn sich ein Render-Client — eine
OBS-Browserquelle oder ein normaler Browser-Tab — mit deiner Szene verbindet
oder trennt. Nutze ihn, um eine Eingangs-Animation abzuspielen, wenn dein
Overlay auf dem Bildschirm erscheint, oder um in den Leerlauf zu gehen, wenn es
verschwindet. Er meldet außerdem, wie viele Clients aktuell verbunden sind. Das
funktioniert auch außerhalb von OBS. Um mehrere Quellen zu unterscheiden, gib
jeder eine feste Kennung, indem du `?obsTarget=name` an ihre URL anhängst und im
Knoten danach filterst.
