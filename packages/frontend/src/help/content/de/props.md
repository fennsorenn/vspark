# Requisiten {#props}

**Requisiten** sind zusätzliche Objekte, die du neben deinem Avatar in der 3D-Szene
platzierst. Es sind keine Figuren – sie sind Dekoration, Medien und interaktive
Elemente, die deinen Stream-Raum lebendig wirken lassen.

## Was sind Requisiten? {#what}

Eine Requisite ist jeder Szenenknoten, der kein Avatar, keine Kamera und kein
Licht ist. Du kannst so viele Requisiten wie gewünscht platzieren, sie
irgendwo positionieren, an Knochen heften (damit eine Requisite einer Hand
folgt) und sie mit Track-Clips oder Logik animieren.

Aktuelle Requisiten-Typen: Bildebenen, Videoebenen, Audioquellen, Textlabels,
Partikelemitter und szeneneigene Feed-Overlays.

## Bild {#image}

Eine **Bildebene** (auch **Billboard** genannt) zeigt ein Standbild in deiner
3D-Welt an. Du kannst beliebige PNG- oder JPG-Dateien hochladen – sie
erscheinen als flaches, texturiertes Rechteck.

- **Ausrichtung: Bildschirm** — das Bild dreht sich immer zur Kamera hin, wie
  ein Sprite. Gut für Logos, Sticker oder flache Dekorationen, die immer lesbar
  sein sollen.
- **Ausrichtung: Welt** — das Bild hat eine feste Ausrichtung im 3D-Raum. Gut
  für Rahmen oder Schilder, die in einem bestimmten Winkel platziert werden.
- Passe **Breite**, **Höhe** und **Alpha** an, um das Bild zu skalieren oder
  auszublenden.

## Video {#video}

Eine **Videoebene** spielt eine Videodatei in der Szene ab. Sie funktioniert
genau wie eine Bildebene, ist aber animiert.

- Unterstützt **Autoplay**, **Schleife** und eine Auswahl, was am Ende des
  Videos passiert (letztes Bild einfrieren oder Ebene ausblenden).
- **Lautstärke** und **Stummschalten** steuern die Tonspur des Videos.
- **Chroma-Keying** entfernt eine Hintergrundfarbe (z. B. Greenscreen), sodass
  das Video vor der Szene ausgeschnitten erscheint.
- **Mischmodi** (Normal, Additiv, Multiplizieren, Negativ multiplizieren)
  bestimmen, wie das Video über der dahinterliegenden Szene compositet wird.

Wiedergabe und Pause lassen sich über Logik-Automatisierungen oder Track-Clips
steuern.

## Audio {#audio}

Ein **Audio-Knoten** spielt eine Sounddatei in der Szene ab, ohne sichtbare
Geometrie anzuzeigen.

- **Einfaches** Audio spielt mit gleicher Lautstärke überall in der Szene –
  gut für Hintergrundmusik oder globale Atmosphäre.
- **Direktionales** Audio nimmt mit dem Abstand vom Knoten ab und erzeugt ein
  räumliches 3D-Gefühl. Konfiguriere den Abklingabstand und die
  Kegelwinkel, um die Klangzone zu formen.
- Unterstützt **Autoplay**, **Schleife** und Lautstärkeregelung.
- Audio ist im Editor standardmäßig stummgeschaltet; im Viewer-Ausgang ist es
  zu hören.

## Text {#text}

Ein **Text-Knoten** rendert eine Zeile oder einen Textblock direkt in der
3D-Szene. Es stehen zwei Rendering-Engines zur Verfügung:

- **Troika-Text** — hochwertiger SDF-Text (bei jeder Größe scharf). Ideal für
  kurze Beschriftungen, Namen und Überschriften.
- **Canvas-Text** — gerasterter Text, der auf eine Ebene gemalt wird.
  Unterstützt **HTML erlauben**, mit dem du formatierten HTML-Inhalt
  (einschließlich Emote-Bilder) einbetten kannst, der bereinigt und in die
  Textur gerendert wird.

Beide unterstützen **Ausrichtung: Bildschirm** (immer lesbar, dreht zur
Kamera) und **Ausrichtung: Welt** (fest im 3D-Raum), Farbe und Schriftgröße.

## Partikel {#particles}

Ein **Partikelemitter** spawnt viele kleine Sprites und simuliert deren
Bewegung über Zeit. Typische Anwendungen: Feuer, Rauch, Funken, Konfetti,
Regen.

Wichtige Einstellungen:

- **Textur** — das Sprite-Bild für jeden Partikel. Mehrere eingebaute Formen
  stehen zur Verfügung; du kannst auch jedes Bild-Asset verwenden.
- **Emissionsrate** — wie viele Partikel pro Sekunde entstehen. Der
  Burst-Modus löst sie alle auf einmal aus.
- **Lebensdauer** — wie lange jeder Partikel existiert, bevor er verschwindet.
- **Richtung, Geschwindigkeit und Streuung** — wohin sich Partikel bewegen.
- **Größe und Farbe über Lebensdauer** — Partikel können schrumpfen, wachsen
  oder die Farbe wechseln, während sie altern.
- **Schwerkraft und Turbulenz** — biegen die Partikelbahnen für eine
  naturalistische Bewegung.

## Feed (szeneninterne Überlagerung) {#feed}

Ein **Feed-Knoten** platziert ein Live-Daten-Overlay direkt in der 3D-Szene
als texturierte Ebene. Dies ist das 3D-Äquivalent einer Feed-Ebene in Compose.

- Der Inhalt wird durch **Datenkanäle** gesteuert – benannte Felder, die von
  Stream-Ereignissen gesendet werden (z. B. ein Abonnenten-Alert, eine
  Chat-Nachricht oder ein benutzerdefinierter Logik-Ausgang).
- Du schreibst eine kleine **Vorlage** (mit `{{Feldname}}`-Platzhaltern), die
  vspark bei jedem neuen Dateneintrag befüllt.
- Benutzerdefiniertes **CSS** steuert die visuelle Gestaltung.
- Wie Text-Knoten können Feed-Knoten zur Kamera zeigen oder eine feste
  Weltausrichtung haben.

Eine vollständige Erklärung von Datenkanälen und Vorlagen findest du unter
[Logik](topic:logic).
