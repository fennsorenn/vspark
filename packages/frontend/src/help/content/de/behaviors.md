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

## Stilisiertes Tracking {#stylized}

Exaktes Tracking ist nicht immer schmeichelhaftes Tracking. Eine Kamera oder ein
VMC-Anzug liefert dir genau das, was dein Körper getan hat — einschließlich der
Momente, in denen der Ellbogen für zwei Bilder verloren ging und dein Arm quer
durch den Raum flog, und einschließlich der Tatsache, dass eine Kopfdrehung nur
den Kopf bewegt, während der Rest von dir dasteht wie eine Schaufensterpuppe.

Stilisiertes Tracking ist ein **Nachbearbeitungsschritt**. Es sitzt zwischen der
Quelle deiner Bewegung und deinem Avatar und formt die Bewegung unterwegs um — so,
wie ein 2D-Avatar gerigged ist: Eine Handvoll grober **Steuerwerte** wird aus
deiner Performance gelesen — wohin dein Kopf zeigt, wohin dein Oberkörper lehnt,
wie hoch deine Arme sind — und diese Steuerwerte werden dann wieder über deinen
ganzen Körper verteilt.

Das löst beide Probleme auf einmal.

**Es wirkt lebendiger.** Eine Kopfdrehung endet nicht mehr am Hals: Sie wandert
durch Brust, Wirbelsäule und Hüfte, jeweils etwas schwächer als darüber und
jeweils etwas später, sodass dein Körper als eine zusammenhängende Performance
gelesen wird. Der Kopf bleibt außerdem waagerecht, wenn sich der Körper neigt,
die Schultern laufen einer Drehung hinterher, und jede Schulter hebt sich, wenn
du den zugehörigen Arm hebst — die Kleinigkeiten, die ein Mensch tut, ohne
darüber nachzudenken, und die Tracking fast nie einfängt.

**Es geht nicht mehr kaputt.** Die vom Rig gesteuerten Knochen werden aus den
Steuerwerten *neu aufgebaut* statt vom Tracking übernommen, und die Steuerwerte
sind auf einen festen Bereich begrenzt und dürfen sich nicht schneller bewegen,
als ein Mensch sich bewegen kann. Ein Tracking-Ruckler kann höchstens einen
Steuerwert anstupsen — aus einem kaputten Bild wird also ein kleines Wackeln
statt eines abgeknickten Gliedes.

### Voreinstellungen

Eine Voreinstellung ist ein Ausgangspunkt für das ganze Verhalten — die
Körperzuordnung, und teilweise auch, wie weit du dich bewegen musst und wie stark
der Körper nachläuft. Alles danach kannst du anpassen; ein Wechsel setzt alles neu
auf, was du nicht selbst geändert hast.

**Körper folgt dem Kopf** *(Standard)* — du drehst den Kopf, und Brust,
Wirbelsäule und Hüfte drehen sich mit. Der ganze Körper lehnt sich in den Blick
hinein. Warm und zugewandt, und die sanftere der beiden Konventionen.

**Körper gegen den Kopf** — du drehst den Kopf, und der Oberkörper dreht sich
dagegen. Der Kontrapost- oder S-Kurven-Eindruck: theatralisch, gestellt, mehr
„Figur“. Es ist nicht einfach die Umkehrung der ersten Variante — Kopf und Hals
tragen deutlich mehr Rotation, um auszugleichen, dass der Oberkörper abzieht statt
zu addieren. So schaust du weiterhin dorthin, wohin du schaust.

**Kopfgesteuert, Körper folgt** — dein Kopf ist das *einzige*, was den Avatar
steuert. Oberkörper- und Arm-Tracking werden vollständig ignoriert. Gut in zwei
Fällen: Du nutzt einen reinen Gesichts-Tracker (ein Handy- oder
Webcam-Gesichtstracker liefert nur Kopfrotation — damit steuert sie einen ganzen
Körper), oder dein Körper-Tracking ist zu verrauscht und der Kopf ist das einzige
saubere Signal. Der Körper dreht sich merklich stärker pro Kopfbewegung, weil es
kein anderes Signal gibt.

**Kopfgesteuert, Körper dagegen** — dasselbe, mit der Kontrapost-Drehung: Dein
Kopf steuert, und der Oberkörper dreht sich dagegen. Zwischen diesen beiden
wählst du wie zwischen dem ersten Paar; es ist dieselbe Charakterfrage, nur auf
einem reinen Kopfsignal.

In beiden kopfgesteuerten Varianten bleibt das **Nicken in Kopf und Hals**, statt
die Wirbelsäule hinunterzuwandern. Das ist Absicht: Drehen und Neigen sind
Ganzkörper-Gesten — du drehst dich aus der Hüfte, um nach hinten zu schauen — aber
ein über die Wirbelsäule verteiltes Nicken liest sich nicht mehr als Nicken,
sondern als *Verbeugung*, und das bedeutet etwas ganz anderes.

**Ausdrucksstark** — dieselbe Zuordnung wie „Körper folgt dem Kopf“, aber es
braucht viel weniger Bewegung für die volle Wirkung, und der Körper läuft weiter
nach. Für alle, die sich wenig bewegen und trotzdem lebendig wirken wollen. Achtung:
Diese Variante **verstärkt** bewusst — dein Avatar dreht sich etwa 1,5-mal so weit
wie du. Wenn du originalgetreues Tracking mit lebendigerem Körper willst, bleib bei
„Körper folgt dem Kopf“ und dreh stattdessen die Stärke hoch.

Keine der ersten beiden ist richtiger; es sind unterschiedliche Charaktere.
Probiere sie aus und behalte die, die zu deinem Avatar passt.

(Es gibt eine zweite, davon unabhängige Kopplung in die andere Richtung: Dein Kopf
dreht immer gegen die Neigung deines *Körpers*, damit dein Blick waagerecht bleibt.
Die ist in jeder Voreinstellung aktiv, denn sie ist es, die einen Körper wie einen
Darsteller statt wie eine Marionette wirken lässt.)

### Die Regler

**Mischung** ist der Regler zwischen beiden Welten: 0 ist dein Tracking unberührt,
1 ist voll stilisiert. Alles dazwischen ist eine Mischung, sodass du etwas von
deiner eigenen Präzision behalten und trotzdem den Nachlauf bekommen kannst.
Fang bei 1 an und geh herunter, wenn es dir zu weich wird.

**Stärke** ist die schnelle Gesamtanpassung: ein Multiplikator darauf, wie weit
die stilisierte Bewegung geht. 1 ist das Rig wie entworfen, unter 1 nimmt alles
zurück, über 1 übertreibt es — bis zum Doppelten.

Die beiden sind leicht zu verwechseln, also: **Mischung fragt, wie viel Stilisierung
du willst, Stärke fragt, wie groß sie sein soll.** Die Mischung herunterzudrehen
lässt mehr von deinem echten Tracking durch. Die Stärke herunterzudrehen behält die
volle Kontrolle bei der Stilisierung, lässt sie aber weniger ausschlagen. Vor allem:
Die Stärke kann *über* 1 gehen und damit über das Rig hinaus — die Mischung kann das
nicht, sie endet bei „voll stilisiert“. Fühlt sich die Bewegung richtig an, ist aber
zu groß oder zu klein, nimm die Stärke; willst du mehr eigene Präzision zurück, nimm
die Mischung.

**Nachlauf** ist, wie weit der Körper den Steuerwerten hinterherläuft, in
Sekunden. Größer ist lockerer und cartoonhafter; 0 lässt alles gleichzeitig
laufen. Wenn die Bewegung *überschwingen* und ausschwingen soll, statt nur
aufzuholen, schalte am Avatar selbst **Bewegungs-Schnappigkeit** ein — sie legt
sich obendrauf.

**Nicht gesteuerte Knochen in Ruhelage** schickt alles außerhalb des Rigs
(Finger, Beine) in seine neutrale Haltung zurück, statt das Tracking
durchzureichen. Genau richtig, wenn ausgerechnet dein Hand-Tracking spinnt.

### Ansprechverhalten

Der Abschnitt **Ansprechverhalten** entscheidet, wie aus deiner Bewegung
Steuerwerte werden. Die drei *Bereich*-Werte sind, wie weit du dich für volle
Wirkung bewegen musst — senke sie, um aus kleinen Bewegungen große stilisierte
Bewegung zu holen, erhöhe sie, wenn der Avatar zappelig wirkt.

Der Rest ist Aufbereitung. Die **Totzone** ist, wie viel Bewegung noch als
Stillhalten gilt — das verhindert, dass Sensorrauschen den Avatar flimmern lässt.
Die **maximale Rate** ist das Tempolimit, das aus einem Tracking-Ruckler eine
kurze Fahrt statt eines Zuckens macht — sie zu senken macht den Avatar ruhiger
und fehlertoleranter. **Glättung** macht alles weicher, um den Preis von etwas
Verzögerung.

### Antwort-Rig

Das **Antwort-Rig** ist die Zuordnung selbst, und du kannst jeden Knochen darin
bearbeiten. Zu jedem Knochen stehen die Steuerwerte, die ihn bewegen, und wie
viele Grad jeder davon bei voller Stärke beiträgt, in X / Y / Z.

Ein Knochen ist in einem von zwei Modi. **Ersetzen** heißt, der Knochen wird
vollständig aus den Steuerwerten gebaut und das Tracking verworfen — das macht
ihn ruckelfest, und es ist die richtige Wahl für Wirbelsäule, Hals, Kopf und
Schultern. **Addieren** behält deine getrackte Bewegung und legt den Beitrag des
Rigs darüber; so arbeiten die Arme, damit deine eigenen Gesten erhalten bleiben.

Ein Wechsel der Variante setzt den ganzen Editor neu auf, aber bereits
überschriebene Knochen behalten deine Werte — setze einen Knochen (oder das ganze
Rig) zurück, um die Werte der neuen Variante zu übernehmen.

**Nachlauf** ist ein Multiplikator pro Knochen auf den globalen Nachlauf. Das
Standard-Rig staffelt ihn die Kette hinunter — die Hüfte läuft am weitesten
hinterher, der Kopf kaum — und genau das erzeugt das Peitschen und Ausschwingen.
Du kannst einem Knochen Steuerwerte hinzufügen, Knochen hinzufügen, die das
Standard-Rig ignoriert (Beine, für ein wiegendes Ganzkörper-Idle), und jeden
Knochen oder das ganze Rig jederzeit auf den Standard zurücksetzen.

Ein schöner Nebeneffekt: Weil Knochen im Modus „Ersetzen“ erzeugt und nicht
kopiert werden, werden sie auch dann gesteuert, wenn dein Tracker sie nie
sendet. Ein reiner Gesichts-Tracker bewegt durch dieses Rig deinen ganzen Körper.

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
