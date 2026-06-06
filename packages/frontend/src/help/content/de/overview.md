# Willkommen bei vspark {#overview}

vspark verwandelt echte Bewegung in eine 3D-Figur auf dem Bildschirm. Du
bringst Bewegung herein (von einer Webcam, einem Smartphone oder Tracking-
Hardware), richtest sie auf einen virtuellen Avatar, und vspark streamt das
Ergebnis in eine Ansicht, die du aufnehmen oder live zeigen kannst.

Du brauchst keinerlei technisches Vorwissen, um loszulegen — diese Anleitung
erklärt jeden Teil in einfacher Sprache. Achte auf die kleinen **?**-Schaltflächen
in der App: Fahre mit der Maus darüber für einen kurzen Hinweis, oder klicke für
die ausführliche Erklärung.

## Die wichtigsten Bereiche {#pieces}

vspark ist in einige Bereiche unterteilt. Die Tabs auf der linken Seite wechseln
zwischen ihnen.

- **[Stage](topic:scene)** — die 3D-Welt. Dein Avatar, die Kameras und die
  Lichter befinden sich hier. Das ist es, was deinem Publikum gezeigt wird.
- **[Avatar](topic:avatar)** — die Figur selbst: wie sie geladen wird, sich
  bewegt, Mimik zeigt und aussieht.
- **[Verhalten](topic:behaviors)** — die „Antriebe“, die Dinge bewegen, etwa das
  Auslesen deiner Webcam oder deines Mikrofons.
- **[Logik](topic:logic)** — optionale Automatisierung: lass Dinge als Reaktion
  auf Ereignisse geschehen (zum Beispiel eine Chat-Nachricht oder eine
  Kanal-Belohnung).
- **Compose** — eine 2D-Ebenen-Anordnung über der 3D-Szene (Overlays, Bilder,
  Webcam-Rahmen) für dein fertiges Stream-Layout.

## Eine typische erste Sitzung {#first-session}

1. Füge der Stage einen **Avatar** hinzu und lade eine `.vrm`-Figurendatei.
2. Hänge ein **Verhalten** an, das deine Bewegung erfasst (Webcam-Tracking oder
   VMC).
3. Sieh zu, wie dein Avatar in der Ansicht zum Leben erwacht.
4. Füge optional **Logik** und **Compose**-Ebenen hinzu, um auf deinen Stream zu
   reagieren.

Jeder dieser Schritte hat eine eigene Seite in dieser Anleitung — nutze die
Themenliste links oder die **?**-Schaltflächen neben den Bedienelementen in der
App.

## Sprache ändern {#language}

Nutze die Sprachauswahl in der oberen Leiste, um zwischen **English** und
**Deutsch** zu wechseln. Deine Wahl wird beim nächsten Öffnen von vspark
gespeichert.

## vspark aktualisieren {#updates}

vspark sucht automatisch im Hintergrund nach Updates. Sobald eine neue Version
verfügbar ist, erscheint eine Benachrichtigung in der oberen Leiste. Öffne das
**Updates**-Panel (klicke auf die Versionsnummer oder die Benachrichtigungsmarke),
um die Änderungen einzusehen und das Update zu installieren.

**Wie es funktioniert.** vspark lädt die neue Version im Hintergrund herunter,
während du weiterarbeitest. Wenn der Download abgeschlossen ist, klicke auf
**Jetzt aktualisieren**, um das Update anzuwenden. vspark startet automatisch
neu und deine Projekte bleiben erhalten — kein manuelles Verschieben von
Dateien ist nötig.

**Release-Kanäle.** Du kannst wählen, wie aktuell deine Updates sind:

- **Stabil** — gründlich getestete Versionen, empfohlen für den täglichen
  Einsatz.
- **Aktuell** (Beta) — fertige Funktionen, die noch verfeinert werden.
  Größtenteils zuverlässig, aber gelegentliche Unebenheiten sind möglich.
- **Experimentell** (Alpha) — die neuesten Vorabversionen. Ideal, um neue
  Funktionen früh auszuprobieren, jedoch mit möglicher Instabilität.

Wechsle den Kanal jederzeit im **Updates**-Panel. vspark prüft sofort nach dem
Wechsel auf die neueste Version des gewählten Kanals.
