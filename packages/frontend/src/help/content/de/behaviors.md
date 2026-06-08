# Verhalten {#behaviors}

Ein **Verhalten** ist etwas, das du an einen Knoten anhängst, damit dieser von
selbst etwas tut. Verhalten sind die Brücke zwischen der Außenwelt (deine Kamera,
dein Mikrofon, deine Tracking-App) und deinem [Avatar](topic:avatar).

Du fügst Verhalten über den **Verhalten**-Tab hinzu und hängst sie an einen
Knoten. Ein einzelner Avatar kann mehrere Verhalten gleichzeitig ausführen — zum
Beispiel Tracking _und_ Lippensynchronisation.

## VMC-Empfänger {#vmc}

**VMC** ist ein verbreiteter Standard, den Motion-Capture-Apps nutzen, um
Posendaten über dein Netzwerk zu senden. Werkzeuge wie Smartphone-Gesichtstracker
und Ganzkörperanzüge können VMC senden; das VMC-Empfänger-Verhalten hört darauf
und leitet es an deinen Avatar weiter.

Du gibst lediglich an, auf welchem Port es lauschen soll (die sendende App zeigt
diesen an), und die Bewegung fließt herein.

## Kamera-Tracking {#tracking}

Kamera-Tracking nutzt eine gewöhnliche **Webcam**, um deine Gesichts-, Hand- und
Körperhaltung zu schätzen — keine spezielle Hardware nötig. Es läuft in deinem
Browser und sendet das Ergebnis an deinen Avatar.

Das ist der einfachste Einstieg: hänge das Tracking-Verhalten an, erlaube den
Kamerazugriff und kalibriere einmal, während du in einer neutralen Pose stehst.

## Lippensynchronisation {#lipsync}

Die Lippensynchronisation hört auf dein **Mikrofon** und wandelt Sprache in
Mundformen um, sodass sich der Mund deines Avatars im Takt deiner Stimme bewegt.
Sie funktioniert auch ohne Gesichts-Tracking, was praktisch ist, wenn du lieber
nicht vor der Kamera bist.

Du kannst sie auf deine eigene Stimme kalibrieren, um schärfere Vokalformen zu
erhalten.

## Atmung {#breathing}

Die Atmung fügt ein dezentes, automatisches Heben und Senken von Brust und
Schultern hinzu, damit dein Avatar lebendig wirkt, selbst wenn du stillhältst.
Das Ausmaß der Brust- und Schulterbewegung ist einstellbar.

## Manuelle Kalibrierung {#manual-calibration}

Mit der manuellen Kalibrierung kannst du die eingehende Pose Knochen für Knochen
von Hand feinjustieren. Für jeden Knochen legst du pro Achse (X, Y, Z) einen
**Multiplikator** und einen **Offset** fest:

- **Multiplikator** skaliert, wie weit eine Drehung entlang dieser Achse reicht.
  `1` lässt sie unverändert, `2` dreht den Knochen doppelt so weit, `0,5` halb so
  weit. Praktisch, wenn eine Tracking-Quelle ein Gelenk zu wenig oder zu stark
  dreht.
- **Offset** verschiebt die neutrale Nullstellung, gemessen in Grad. Damit
  korrigierst du die Ruhepose eines Knochens — etwa um zu hoch sitzende Schultern
  zu entspannen.

Betroffen sind nur die Knochen, die du tatsächlich änderst; alles andere bleibt
unverändert. Änderungen wirken live beim Ziehen, sodass du den Avatar reagieren
siehst. Ein mit einem Punkt markierter Knochen hat eine aktive Kalibrierung;
**Knochen zurücksetzen** löscht einen Knochen, **Alle zurücksetzen** löscht alles.

Da die Anpassung achsenweise auf Euler-Winkeln arbeitet, können sehr große
Korrekturen nahe der Senkrechten eines Knochens nichtlinear wirken — sie ist zum
Feinjustieren gedacht, nicht zum kompletten Neu-Rigging.

## Kamera & Mikrofon einrichten {#devices}

Im **Medienfenster** wählst du aus, welche Kamera und welches Mikrofon vspark
verwenden soll. Öffne es über die Werkzeugleiste; es kann auch in einem
separaten Browser-Tab laufen, damit es aktiv bleibt, während du das Fenster
wechselst.

**Gerät auswählen.** Nutze die Auswahlmenüs, um die gewünschte Kamera oder
das gewünschte Mikrofon festzulegen. Die Liste wird beim ersten Start einer
Aufzeichnungssitzung befüllt. Falls ein Gerät nicht erscheint, prüfe, ob es
angeschlossen ist und nicht von einer anderen App belegt wird.

**Browser-Berechtigungen.** Die Aufnahme läuft vollständig im Browser — kein
Plugin oder Treiber ist erforderlich. Beim ersten Start von Tracking oder
Lippensynchronisation fragt der Browser nach der Berechtigung für den Zugriff
auf Kamera oder Mikrofon. Erteile die Erlaubnis, und das Gerät wird für die
aktuelle Sitzung gespeichert. Hast du die Berechtigung versehentlich abgelehnt,
öffne die Website-Einstellungen deines Browsers für vspark, setze die
Berechtigung zurück und lade die Seite neu.

**Kalibrieren.** Nachdem du das Tracking gestartet hast, nimm eine entspannte,
neutrale Haltung ein und klicke auf **Kalibrieren** (sofern angezeigt). Damit
lernt vspark deine Standard-Stehhaltung kennen, sodass Abstände und
Proportionen korrekt auf den Avatar übertragen werden. Bei der
Lippensynchronisation hilft es, einige Vokale zu sprechen, während der
Pegelanzeiger sichtbar ist, damit das System deine Stimmstärke erlernt.

## API-Steuerung {#api}

> **Fortgeschritten.** Dieses Verhalten richtet sich an Nutzer, die Skripte
> oder Automatisierungstools einsetzen, um vspark von außen zu steuern.

Das Verhalten „API-Steuerung" gibt vsparks lokale HTTP-API frei, sodass externe
Werkzeuge — Skripte, Stream-Deck-Makros oder andere Programme — Animationen
auslösen, Mimik setzen oder Szenen-Eigenschaften zur Laufzeit anpassen können.
Du konfigurierst das Verhalten einmalig; die API ist danach im lokalen Netzwerk
auf dem im Panel angezeigten Port erreichbar. Die vollständige Liste der
Endpunkte und Nutzlastformate findest du in der API-Referenz (im Hilfemenü
zugänglich).
