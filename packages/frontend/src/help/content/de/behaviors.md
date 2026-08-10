# Verhalten {#behaviors}

Ein **Verhalten** ist etwas, das du an einen Knoten anhängst, damit dieser von
selbst etwas tut. Verhalten sind die Brücke zwischen der Außenwelt (deine Kamera,
dein Mikrofon, deine Tracking-App) und deinem [Avatar](topic:avatar).

Du fügst Verhalten über den **Verhalten**-Tab hinzu und hängst sie an einen
Knoten. Ein einzelner Avatar kann mehrere Verhalten gleichzeitig ausführen — zum
Beispiel Tracking *und* Lippensynchronisation.

## VMC-Empfänger {#vmc}

**VMC** ist ein verbreiteter Standard, den Motion-Capture-Apps nutzen, um
Posendaten über dein Netzwerk zu senden. Werkzeuge wie Smartphone-Gesichtstracker
und Ganzkörperanzüge können VMC senden; das VMC-Empfänger-Verhalten hört darauf
und leitet es an deinen Avatar weiter.

Du gibst lediglich an, auf welchem Port es lauschen soll (die sendende App zeigt
diesen an), und die Bewegung fließt herein.

## iFacialMocap-Empfänger {#ifacialmocap}

**iFacialMocap** ist eine iPhone-/iPad-App, die Apples Gesichtstracking nutzt, um
deine Mimik aufzunehmen. Dieses Verhalten empfängt diesen Stream und steuert
damit **Kopf, Augen und Gesichts-Blendshapes** deines Avatars — es ist eine reine
Gesichtsquelle, Arme, Hände und Beine spielen also weiter ihre Animation.

Beide Geräte müssen im selben Netzwerk sein. Es gibt zwei Wege zu verbinden:

- **Trage die Geräte-IP ein**, die dir die App auf dem Telefon anzeigt. vspark
  fordert den Stream dann beim Telefon an und verbindet sich von selbst neu,
  wenn die App neu gestartet wird.
- **Lass die Geräte-IP leer** und trage stattdessen eine der aufgeführten
  Rechner-Adressen in der App ein; starte den Stream dann vom Telefon aus.

In beiden Fällen sprechen beide Seiten über Port **49983**, den Port der App.

### Es kommt nichts an, obwohl die App eine Verbindung meldet {#ifacialmocap-firewall}

Das ist fast immer die **Firewall** deines Computers.

Die App meldet eine Verbindung, sobald sie zu *senden* beginnt. Sie kann nicht
erkennen, ob etwas bei vspark ankommt — ein blockierter eingehender Port sieht
vom Telefon aus also genauso aus wie eine funktionierende Verbindung, während
vspark mit dunklem Verbindungspunkt und reglosem Avatar dasteht.

Erlaube eingehendes **UDP auf Port 49983**, dann funktioniert es sofort, ohne
Neustart. Unter Windows erscheint die Abfrage meist beim ersten Öffnen des Ports;
wenn du sie einmal weggeklickt hast, muss die Regel von Hand angelegt werden.

Bewegt sich dein Kopf in die falsche Richtung — nickt er etwa nach oben, wenn du
nach unten nickst — kehre den passenden Schalter unter **Kopfachsen** um. Wenn
die Richtungen stimmen, nimm eine entspannte neutrale Haltung ein und drücke
**Erfassen**, damit deine Ruhehaltung zur Ruhehaltung des Avatars wird.

Die Mimik wird genau wie beim [VMC-Empfänger](topic:behaviors#vmc) zugeordnet —
dieselben drei Gesichts-Mapper, derselbe Editor für eigene Zuordnungen.

## Kamera-Tracking {#tracking}

Kamera-Tracking nutzt eine gewöhnliche **Webcam**, um deine Gesichts-, Hand- und
Körperhaltung zu schätzen — keine spezielle Hardware nötig. Es läuft in deinem
Browser und sendet das Ergebnis an deinen Avatar.

Das ist der einfachste Einstieg: hänge das Tracking-Verhalten an, erlaube den
Kamerazugriff und kalibriere einmal, während du in einer neutralen Pose stehst.

Die Schalter **Gesicht**, **Pose** und **Hände** bestimmen, welche Teile erfasst
werden. **HD-Gesicht** steuert, wie der Gesichtsausdruck geschätzt wird: aus (die
Voreinstellung) leitet ihn günstig aus den ohnehin erfassten Gesichtspunkten ab,
während ein eigens hochwertiges Gesichtsmodell für genauere Ausdrücke sorgt — auf
Kosten zusätzlicher CPU-Last. Aktiviere es nur, wenn deine Maschine eine flüssige
Bildrate hält.

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

## Mimik-Begrenzungen {#expression-limits}

Gesichtstracking, Lippensynchronisation und manuell gesetzte Mimik landen alle
im selben Frame und addieren sich standardmäßig einfach auf. Genau daraus
entstehen die übertriebenen oder schlicht kaputten Gesichter, die man manchmal
sieht: Volle **Freude** kneift die Augen bereits zusammen, ein zusätzliches
Blinzeln lässt die Lider dann in sich zusammenfallen, und ein weit geöffneter
Lipsync-Vokal auf einem Freude-Lächeln dehnt den Mund über das hinaus, wofür das
Modell gebaut wurde.

Das Verhalten **Mimik-Begrenzungen** ist ein korrigierender Durchgang über den
fertigen Mimik-Frame, kurz bevor er den Avatar erreicht. Füge es einem Avatar
hinzu, und es wirkt sofort — die mitgelieferten Standardwerte decken die
üblichen Fälle ab.

**Exklusive Gruppen.** Mimiken einer Gruppe können nicht gleichzeitig auftreten.
Die stärkste setzt sich durch, die übrigen werden in dem Maß ausgeblendet, wie
stark sie ist — konkurrierende Emotionen blenden also ineinander über, statt zu
springen. Standardmäßig liegen alle fünf Emotions-Vorgaben — Freude, Wut,
Trauer, Entspannung und Überraschung — in einer Gruppe, dein Avatar kann also
immer nur eines davon sein. „Summe normalisieren“ ist die sanftere Alternative:
Niemand gewinnt, aber wenn die Mimiken der Gruppe zusammen über 1 kommen, werden
sie alle so weit zurückgenommen, bis es passt.

**Begrenzungsregeln.** Solange eine auslösende Mimik aktiv ist, wird eine Menge
von Zielformen in einen kleineren Bereich gedeckelt. Die beiden mitgelieferten
Regeln nutzen beide Freude als Auslöser: Die eine hält die Augenschluss- und
Blinzelformen zurück, die andere die Mundöffnungsformen und Lipsync-Vokale. Die
„Schwelle“ legt fest, wie stark der Auslöser sein muss, bevor die Regel
überhaupt greift; mit „Mit Auslöser einblenden“ zieht sich die Begrenzung
allmählich zu, statt schlagartig einzusetzen.

**Namen.** Namen werden ohne Rücksicht auf Groß- und Kleinschreibung verglichen,
und `*` dient als Platzhalter — `Fcl_MTH_*` erfasst mit einem Eintrag sämtliche
VRoid-Mundformen. So deckt ein Regelsatz Modelle ab, die dieselbe Mimik `happy`,
`Joy` oder `Fcl_ALL_Joy` nennen. Eine Mitgliedszeile enthält gerade deshalb
mehrere Namen, weil sie für dein Modell alle *dieselbe* Mimik sind; das
Eingabefeld schlägt die Namen vor, die dein geladener Avatar tatsächlich
anbietet. Eine Regel, die eine Form nennt, die dein Modell nicht hat, bewirkt
schlicht nichts.

**Rohes JSON.** Der gesamte Regelsatz ist unten im Panel als JSON editierbar —
der schnellste Weg, eine eingestellte Konfiguration von einem Avatar auf einen
anderen zu übertragen. „Auf Standard zurücksetzen“ stellt die mitgelieferten
Regeln wieder her.

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
