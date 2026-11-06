# OBS-Integration {#obs}

vspark kann sowohl *auf* OBS reagieren als auch OBS *steuern* — alles über den
**Logik**-Tab. Szenen zeitgesteuert wechseln, den Wiederholungspuffer starten,
wenn ein Zuschauer erscheint, die Musik absenken, während du sprichst, oder
einen gespeicherten Clip feiern.

## vspark mit OBS verbinden {#obs-websocket}

All das läuft über **obs-websocket**, das OBS bereits mitbringt. Einmalig
einrichten:

1. Öffne in OBS **Werkzeuge → WebSocket-Servereinstellungen** und aktiviere den
   Server.
2. Übertrage den dort angezeigten **Server-Port** und das **Server-Passwort**.
3. Trage beides in vspark unter **Konten → OBS-Verbindungen** ein. Da vspark auf
   demselben Rechner wie OBS läuft, bleibt der Host `localhost`.

Die Verbindung liegt im Backend und stellt sich automatisch wieder her. Ihr
Status wird als Punkt neben der Verbindung im Konten-Panel angezeigt, und der
Knoten **OBS Verbindungsstatus** lässt deinen Graphen reagieren, wenn die
Verbindung abbricht oder zurückkehrt.

Ohne Verbindung tun die folgenden OBS-Knoten nichts — und schreiben genau das
ins Backend-Protokoll, mitsamt Knoten und Grund.

## Auf OBS reagieren {#events}

Diese Knoten lösen aus, wenn sich in OBS etwas ändert:

- **OBS Szene gewechselt** — löst aus, wenn die aktive Programmszene wechselt.
  Gibt den Namen der neuen Szene und die Leinwandgröße aus. Trage einen
  Szenennamen im Knoten ein, um nur auf diese Szene zu reagieren.
- **OBS Ausgabestatus** — löst aus, wenn Streaming, Aufnahme, der
  Wiederholungspuffer oder die virtuelle Kamera startet oder stoppt. Gibt aus,
  welche Ausgabe sich geändert hat, den Übergang (gestartet / gestoppt /
  pausiert / gespeichert …) und ob sie jetzt aktiv ist. Ein gespeicherter
  Wiederholungs-Clip ist ein guter Auslöser für eine Jubel-Animation.
- **OBS Lautstärke geändert** / **OBS Stummschaltung geändert** — reagieren, wenn
  du einen Regler bewegst oder eine Quelle stummschaltest.
- **OBS Verbindungsstatus** — reagieren, wenn die OBS-Verbindung auf- oder
  abgebaut wird.

## OBS steuern {#actions}

Diese Knoten weisen OBS an, beim Auslösen etwas zu tun:

- **OBS Szene setzen** / **OBS Übergang setzen** — die aktive Programmszene oder
  den aktiven Szenenübergang per Namen wechseln.
- **OBS Steuerung** — Streaming, Aufnahme (samt Pause/Fortsetzen), den
  Wiederholungspuffer (einschließlich *Speichern*) oder die virtuelle Kamera
  starten/stoppen.
- **OBS Lautstärke setzen** / **OBS Stumm** — die Lautstärke eines Audio-Eingangs
  setzen (in dB oder als linearer Multiplikator) oder ihn stummschalten /
  aufheben / umschalten. Ideal, um bei einer Spende die Musik abzusenken, oder
  für eine Boss-Key-Stummschaltung.
- **OBS Wiederholungspfad** — den Dateipfad des zuletzt gespeicherten
  Wiederholungs-Clips abrufen, um mit der Datei selbst weiterzuarbeiten.

> **Seitenberechtigungen der Browserquelle spielen keine Rolle mehr.** Frühere
> vspark-Versionen schickten Szenen- und Ausgabesteuerung über die
> OBS-Browserquelle, wo OBS alles oberhalb der Berechtigungsstufe der Quelle
> stillschweigend ignorierte — Aktionen konnten also folgenlos verpuffen.
> Inzwischen läuft alles über obs-websocket, das keine solche Sperre kennt und
> jeden Fehlschlag meldet. Die Seitenberechtigungen der Browserquelle kannst du
> unangetastet lassen.

## Auf erscheinende Clients reagieren {#lifecycle}

Der Knoten **Client-Lebenszyklus** löst aus, wenn sich ein Render-Client — eine
OBS-Browserquelle oder ein normaler Browser-Tab — mit deiner Szene verbindet
oder trennt. Nutze ihn, um eine Eingangs-Animation abzuspielen, wenn dein
Overlay auf dem Bildschirm erscheint, oder um in den Leerlauf zu gehen, wenn es
verschwindet. Er meldet außerdem, wie viele Clients aktuell verbunden sind.
Dieser Knoten benötigt überhaupt keine OBS-Verbindung. Um mehrere Quellen zu
unterscheiden, gib jeder eine feste Kennung, indem du `?obsTarget=name` an ihre
URL anhängst und im Knoten danach filterst.
