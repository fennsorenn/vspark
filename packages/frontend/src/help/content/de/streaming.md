# Stream-Konten {#streaming}

Stream-Konten verbinden vspark mit deinen Live-Stream-Plattformen —
Twitch und StreamElements — damit vspark in Echtzeit auf Ereignisse in
deinem Kanal reagieren kann.

Du brauchst kein technisches Vorwissen, um das einzurichten. Folge den
Schritten unten, um ein Konto zu verknüpfen, und wechsle dann zum Tab
**Logik**, um es zu nutzen.

## Was sind Stream-Konten? {#what}

Ein Stream-Konto ist eine autorisierte Verbindung zwischen vspark und einem
Streaming-Dienst. Sobald ein Konto verbunden ist, kann vspark Live-Ereignisse
von diesem Dienst empfangen — neue Follower, Abonnements, Chat-Befehle,
Kanalpunkte-Einlösungen und mehr — und sie an deine Logik-Automatisierungen
weitergeben.

Du verwaltest Konten im Panel **Stream-Konten** (das Konto-Symbol in der
oberen Leiste). Du kannst beliebig viele Konten verbinden; eines wird als
**Standard**-Konto festgelegt und verwendet, wenn in einem Logik-Knoten kein
bestimmtes Konto ausgewählt ist.

## Twitch verbinden {#connect-twitch}

Für die Twitch-Verbindung musst du zunächst eine kostenlose Entwickler-App
bei Twitch registrieren. Das dauert etwa zwei Minuten und muss nur einmal pro
Projekt erledigt werden.

1. Öffne das Panel **Stream-Konten** und klicke auf **+ App registrieren**.
2. Folge der Schritt-für-Schritt-Anleitung — du wirst aufgefordert,
   `dev.twitch.tv/console/apps` aufzurufen, dort eine App zu erstellen und die
   **Client ID** sowie das **Client Secret** in vspark einzufügen.
3. Sobald die App gespeichert ist, klicke auf **+ Twitch**. Ein Anmeldefenster
   öffnet sich.
4. Melde dich mit deinem Twitch-Konto an und klicke auf **Autorisieren**.
   vspark schließt das Fenster automatisch, wenn die Verbindung erfolgreich war.

Dein Twitch-Konto erscheint nun in der Liste mit einem grünen Badge
**Verbunden**.

> **Tipp:** Wenn das Fenster grau bleibt und nichts passiert, prüfe, ob dein
> Browser Popups für diese Seite blockiert.

## StreamElements verbinden {#connect-se}

StreamElements verwendet anstelle eines OAuth-Flusses einen JWT-Token.

1. Gehe zu `streamelements.com/dashboard/account/channels` und kopiere deinen
   **JWT-Token** und deine **Kanal-ID**.
2. Öffne in vspark **Stream-Konten** und klicke auf **+ StreamElements**.
3. Füge JWT und Kanal-ID in das Formular ein, gib dem Konto eine Bezeichnung
   und klicke auf **Speichern**.

Dein StreamElements-Konto erscheint sofort in der Liste.

## Konten in der Logik verwenden {#using}

Sobald ein Konto verbunden ist, stehen seine Ereignisse als Trigger-Knoten im
**[Logik](topic:logic#triggers)**-System zur Verfügung. Füge einen Trigger-Knoten
(z. B. *Twitch — Neuer Follower* oder *StreamElements — Einlösung*) in ein
Automatisierungs-Canvas ein und verbinde ihn mit der gewünschten Aktion.

Eine vollständige Erklärung, wie Trigger und Verbindungen funktionieren, findest
du auf der [Logik-Seite](topic:logic#triggers).
