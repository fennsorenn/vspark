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

- **OBS Szene setzen** / **OBS Übergang setzen** — die aktive Szene oder den
  aktiven Übergang per Namen wechseln.
- **OBS Steuerung** — Streaming, Aufnahme (samt Pause/Fortsetzen), den
  Wiederholungspuffer (einschließlich *Speichern*) oder die virtuelle Kamera
  starten/stoppen.

> **Berechtigungen.** Steuerungsaktionen funktionieren nur, wenn die
> **Seitenberechtigungen** der Browserquelle (in deren OBS-Eigenschaften) hoch
> genug sind — „Erweitert" für Szenen- und Übergangswechsel, „Alle" für die
> Steuerung von Streaming/Aufnahme/virtueller Kamera. OBS ignoriert Aktionen
> oberhalb der gewährten Stufe stillschweigend; wenn ein Steuerungsknoten also
> nichts zu bewirken scheint, erhöhe die Berechtigungsstufe.

## Auf erscheinende Clients reagieren {#lifecycle}

Der Knoten **Client-Lebenszyklus** löst aus, wenn sich ein Render-Client — eine
OBS-Browserquelle oder ein normaler Browser-Tab — mit deiner Szene verbindet
oder trennt. Nutze ihn, um eine Eingangs-Animation abzuspielen, wenn dein
Overlay auf dem Bildschirm erscheint, oder um in den Leerlauf zu gehen, wenn es
verschwindet. Er meldet außerdem, wie viele Clients aktuell verbunden sind. Das
funktioniert auch außerhalb von OBS. Um mehrere Quellen zu unterscheiden, gib
jeder eine feste Kennung, indem du `?obsTarget=name` an ihre URL anhängst und im
Knoten danach filterst.
