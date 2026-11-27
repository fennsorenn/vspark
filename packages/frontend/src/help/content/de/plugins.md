# Plugins {#overview}

**Plugins** erweitern vspark ohne neue vspark-Version: neue Knoten für
[Logik](topic:logic)-Graphen, neue [Aktionen](topic:actions) und Reaktionen,
neue Widgets in der Ebenen-Palette und Verbindungen zu Diensten wie Spotify.
Die Hilfeseiten eines Plugins erscheinen in diesem Hilfefenster unter seinem
Namen.

Plugins laufen mit denselben Rechten wie vspark selbst – installiere nur
Plugins, denen du vertraust.

## Plugin-Konten {#accounts}

Ein Plugin, das mit einem Dienst spricht, bringt einen eigenen Block im
Fenster **Konten** mit. Konten gehören zu einem Projekt, wie Twitch-Konten.

1. Lege beim Dienst eine App an (die Hilfeseite des Plugins erklärt, wo) und
   trage die im Block angezeigte **Redirect-URI** ein. Sie beginnt mit
   `http://127.0.0.1:` – `localhost` akzeptieren die Dienste dort nicht.
2. Trage die Daten der App (zum Beispiel ihre Client-ID) im Block ein.
3. Klicke auf **Verbinden** und melde dich im neuen Fenster an.

Das erste Konto eines Dienstes ist das **Standardkonto** des Projekts; Knoten
und Aktionen ohne gewähltes Konto nutzen es. **Neu verbinden** erscheint, wenn
der Dienst eine neue Anmeldung verlangt. Deine Anmelde-Tokens verlassen diesen
Computer nie.

## Fehlende Plugins {#missing}

Ein Knoten, dessen Plugin nicht installiert ist (oder nicht läuft), erscheint
als **⚠ Fehlt: …**. Er und seine Verbindungen bleiben erhalten und tun nichts,
bis das Plugin wieder läuft. Wenn dir jemand eine Szene teilt, kann vspark dir
den Namen des Plugins nennen, das ein Knoten braucht – auch wenn du es nicht
hast.
