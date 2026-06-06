# Partikel {#particles}

Ein Partikelemitter spawnt einen Pool aus kleinen texturierten Sprites und simuliert ihre Bewegung in jedem Frame. Alle Parameter sind live — du kannst sie bei laufendem Emitter ändern und die Wirkung sofort sehen.

## Emissionsrate {#emission}

**Emissionsrate** — wie viele neue Partikel pro Sekunde entstehen. Standard: 20. Bei 1 tröpfelt der Emitter einen Partikel pro Sekunde; bei 100 entsteht ein dichter, kontinuierlicher Strom. Eine höhere Rate füllt die Szene schneller; in Kombination mit einem höheren Max. Anzahl-Wert (siehe Rendering) lässt sich eine größere Wolke aufrechterhalten.

**Burst-Modus** — wenn aktiviert, werden alle `Max. Anzahl`-Partikel in einem einzigen Frame auf einmal abgefeuert, statt gleichmäßig über die Zeit verteilt. Nützlich für Explosionen oder einmalige Konfetti-Schüsse. Der Emitter stoppt nach dem Burst; aktiviere Schleife, um ihn zu wiederholen.

**Schleife** — wenn aktiviert, startet der Emitter nach jedem Burst automatisch neu bzw. läuft im normalen Modus dauerhaft. Standard: ein.

**Abspielen beim Start** — wenn aktiviert, beginnt der Emitter zu spielen, sobald der Knoten geladen wird. Standard: ein. Deaktiviere dies, wenn du die Wiedergabe über eine Logik-Automatisierung steuern möchtest.

## Lebensdauer {#lifetime}

**Lebensdauer** — wie lange jeder Partikel in Sekunden existiert, bevor er verschwindet. Standard: 2 s. Kurze Werte (0,1 – 0,5 s) halten die Wolke eng am Emitter. Lange Werte (5 – 10 s) lassen Partikel weit driften, bevor sie verblassen.

**Lebensdauer-Zufall** — fügt jedem Partikel eine zufällige Abweichung der Lebensdauer hinzu. Bei 0 leben alle Partikel genau die eingestellte Dauer. Bei 0,5 schwankt die tatsächliche Lebensdauer jedes Partikels um bis zu ±50 % des Basiswerts. Standard: 0,2. Ein höherer Wert verhindert, dass alle Partikel gleichzeitig verschwinden.

## Größe {#size}

**Breite / Höhe** — die Basisgröße jedes Partikel-Sprites in Welteinheiten. Standard: 0,05 × 0,05. Eine Welteinheit entspricht ungefähr der Körpergröße eines Avatars, 0,05 also etwa einer Fingerbreite. Verdopple die Werte für größere, besser sichtbare Partikel; verringere sie auf 0,01 für einen feinen Staubeffekt.

**Breite-Zufall / Höhe-Zufall** — Größenvariation pro Partikel als Anteil der Basisgröße (0 – 1). Bei 0 haben alle Partikel dieselbe Größe. Bei 0,5 schwankt die Größe einzelner Partikel um bis zu ±50 %. Standard: jeweils 0,2. Höhere Werte erzeugen ein organisches, ungleichmäßiges Erscheinungsbild.

**Größe über Lebensdauer** — wie sich die Größe jedes Partikels mit dem Altern verändert:

- `constant` — die Größe bleibt während der gesamten Lebensdauer konstant.
- `shrink` — beginnt in voller Größe und schrumpft bis zum Tod auf null. Standard. Gut für Feuer oder Funken, die natürlich ausblenden.
- `grow` — startet unsichtbar und wächst auf die volle Größe. Gut für Rauchschwaden, die nach außen quellen.
- `pulse` — wächst und schrumpft in einem gleichmäßigen Bogen (volle Sinuswelle über die Lebensdauer). Gut für Leuchteffekte oder Blasen.

## Farbe & Alpha {#color}

**Startfarbe / Endfarbe** — die Farbe, die jeder Partikel bei seiner Entstehung bzw. beim Tod hat. Dazwischen wird die Farbe linear interpoliert. Standards: Weiß → Orange-Rot. Für Rauch: Weiß → Dunkelgrau. Für einen kühlen Energieeffekt: Cyan → transparent (über „Alpha über Lebensdauer").

**Alpha** — die Basisdeckkraft jedes Partikels, von 0 (unsichtbar) bis 1 (vollständig opak). Standard: 1. Ein niedrigerer Wert macht das gesamte System transparenter, ohne die Abklingkurve zu verändern.

**Alpha über Lebensdauer** — wie sich die Deckkraft jedes Partikels mit dem Altern verändert:

- `constant` — die Deckkraft bleibt während der gesamten Lebensdauer beim Alpha-Basiswert.
- `fade-in` — beginnt transparent und erreicht den vollen Alpha-Wert am Ende der Lebensdauer.
- `fade-out` — beginnt beim vollen Alpha-Wert und blendet bis auf null aus. Standard. Der natürlichste Look für Feuer, Rauch und Staub.
- `fade-in-out` — blendet in der ersten Lebenshälfte ein und in der zweiten aus. Gut für funkelnde Effekte.

**Emissive Intensität** — Multiplikator, der im Shader zusätzlich auf die Partikelfarbe angewendet wird. Standard: 1. Werte über 1 lassen Partikel heller erscheinen als ihre reine Farbe, was bei additivem Mischen nützlich ist, um leuchtende Glut oder lichtaussendende Funken zu simulieren. Bei normalem Mischen hat dieser Wert keinen sichtbaren Effekt.

## Richtung & Geschwindigkeit {#direction}

**Richtung X / Y / Z** — die Hauptachse, entlang der Partikel beim Spawnen reisen. Standard: (0, 1, 0) — senkrecht nach oben. Ändere Y auf −1 für fallenden Regen oder Schnee. Mit (1, 0, 0) schießt ein horizontaler Strom seitwärts. Der Vektor muss nicht normalisiert sein; das geschieht automatisch.

**Streuung** — wie weit der Emissionskegel aufgeht, in Grad (0 – 180). Standard: 30°. Bei 0° fliegen alle Partikel exakt in Richtungsvektor — ein enger Strahl. Bei 90° fächern sie sich zu einer Halbkugel auf. Bei 180° können Partikel in jede Richtung gehen (Kugel). Eine größere Streuung lässt Effekte wie Feuer und Rauch voller und natürlicher wirken.

**Geschwindigkeit** — wie schnell jeder Partikel in Welteinheiten pro Sekunde reist. Standard: 1. Für langsam treibenden Nebel: 0,2; für schnelle Funken: 3 – 5.

**Geschwindigkeits-Zufall** — Geschwindigkeitsvariation pro Partikel (0 – 1). Bei 0 bewegen sich alle Partikel mit exakt der eingestellten Geschwindigkeit. Bei 0,5 schwankt die Geschwindigkeit jedes Partikels um bis zu ±50 %. Standard: 0,3. Erhöht die natürliche Variation in einer Wolke.

## Emissionsbereich {#origin}

Diese drei Werte definieren eine Box, zentriert auf den Emitter, aus der Partikel zufällig gespawnt werden. Jeder Wert ist die halbe Ausdehnung (Radius) in Welteinheiten entlang dieser Achse. Alle Standardwerte sind 0 — alle Partikel spawnen vom exakten Emitterpunkt aus.

**Ursprung Breite (X)** — Streuung entlang der X-Achse. Bei 0,5 können Partikel überall in einem 1 Einheit breiten Band spawnen. Damit lässt sich ein Linien-Emitter entlang X erstellen.

**Ursprung Höhe (Y)** — Streuung entlang der Y-Achse. Nützlich für eine vertikale Säule oder einen hohen Quellbereich.

**Ursprung Tiefe (Z)** — Streuung entlang der Z-Achse. Kombiniere alle drei für einen volumetrischen Spawn-Bereich — zum Beispiel eine 1 × 1 × 1 Würfel-Ursprungszone für ein Lagerfeuer, aus dem über der gesamten Feuerfläche Glut aufsteigt.

## Bewegung (Schwerkraft / Kräfte) {#motion}

**Schwerkraft X / Y / Z** — konstante Beschleunigung, die jedem aktiven Partikel pro Frame in Welteinheiten pro Sekunde² aufgeprägt wird. Standard: (0, −0,5, 0) — ein leichter Zug nach unten. Setze Y auf 0 für schwebende, schwerelose Partikel. Erhöhe den Betrag auf −2 oder −3 für dramatisch fallende Funken. Ein positives Y erzeugt aufsteigende Blasen. X und Z können Windeffekte erzeugen.

**Turbulenz** — fügt jedem Partikel pro Frame eine kontinuierliche, rauschbasierte Zufallsperturbation der Geschwindigkeit hinzu. Standard: 0 (aus). Bei 0,1 wackeln Partikel leicht — gut für Rauch. Bei 0,5 werden die Bahnen spürbar chaotisch. Sehr hohe Werte lassen Partikel unregelmäßig zittern.

## Rotation {#rotation}

**Rotationsmodus** — steuert, wie jedes Partikel-Sprite um seine Mitte rotiert:

- `free` — jeder Partikel beginnt mit einer zufälligen Startrotation und dreht sich mit einer festen Winkelgeschwindigkeit. Gut für taumelnde Trümmer, Blätter oder Schneeflocken.
- `velocity` — die Oberkante des Sprites ist immer in Richtung der aktuellen Reiserichtung auf dem Bildschirm ausgerichtet. Gut für gerichtete Funken, Regenstreifen oder Geschwindigkeitslinien, bei denen die Form nach vorne zeigen soll.

**Rotationsstart** — im `free`-Modus wird die Startrotation jedes Partikels zufällig im Bereich ±dieses Werts (Grad) gewählt. Standard: 180°. Bei 180° beginnen Partikel in jedem möglichen Winkel. Bei 0° starten alle aufrecht. Hat keinen Effekt im `velocity`-Modus.

**Winkelgeschwindigkeit** — im `free`-Modus, wie viele Grad pro Sekunde sich jeder Partikel dreht. Standard: 0 (keine Drehung). Positive Werte drehen im Uhrzeigersinn von vorne gesehen; negative entgegen dem Uhrzeigersinn. Für sichtbares Taumeln: 90° – 360°.

**Winkelgeschwindigkeits-Zufall** — im `free`-Modus, Variation um die Basis-Winkelgeschwindigkeit pro Partikel (Grad/s). Bei 0 drehen sich alle Partikel gleich schnell. Höhere Werte lassen manche Partikel schneller und andere langsamer rotieren.

## Rendering (Mischmodus, Max. Anzahl, Tiefe) {#rendering}

**Mischmodus** — wie die Farbe jedes Partikels mit dem dahinter liegenden Bild kombiniert wird:

- `additive` — die Partikelfarbe wird zur dahinter liegenden Szene addiert. Standard. Helle, überlappende Partikel summieren sich zu einem leuchtenden Effekt. Schwarze Bereiche des Sprites werden vollständig transparent. Am besten für Feuer, Funken, Leuchten, Laser.
- `normal` — Standard-Alpha-Compositing. Das Alpha des Partikels steuert, wie stark es das dahinter Liegende verdeckt. Korrekt für opake oder halbtransparente Sprites wie Rauchschwaden oder Blasen.
- `multiply` — die Partikelfarbe wird mit der dahinter liegenden Szene multipliziert. Dunkelt das Dahinterliegende ab; Weiß wird transparent. Nützlich für schattenartige Overlays.

**Simulationsraum** — ob der Partikelpool im Weltkoordinatensystem oder im lokalen Koordinatensystem simuliert wird:

- `world` — Partikelposition werden im Weltkoordinatensystem verfolgt. Wenn der Emitter bewegt wird, bleiben bereits gespawnte Partikel an ihrem Ort. Gut für Feuer, Funken oder alles, das eine Spur im Raum hinterlässt.
- `local` — Partikelpositionen folgen dem Emitter. Wenn du den Emitter-Knoten bewegst, bewegt sich die gesamte Wolke mit. Gut für Auras, Kraftfelder oder Effekte, die an einer Figur haften.

**Max. Anzahl** — die Gesamtzahl der Partikel, die gleichzeitig aktiv sein können. Standard: 200. Der Pool wird vorab reserviert; eine Änderung dieses Werts löst eine Speicherneuallokation aus. Erhöhe auf 500 – 2000 für dichte Effekte (mit gewissem GPU-Mehraufwand). Verringere auf 50 – 100 für dezente Akzente, die keine große Wolke benötigen.

**Tiefe schreiben** — wenn aktiviert, schreiben Partikel in den Tiefenpuffer, was dazu führen kann, dass sie andere Partikel oder Szenengeometrie abschneiden. Standard: aus. Lass diese Option für normale transparente Partikel deaktiviert. Aktiviere sie nur, wenn Partikel bestimmte Geometrie verdecken sollen und Z-Fighting kein Problem darstellt.

**Tiefentest** — wenn aktiviert, werden Partikel hinter solider Geometrie verborgen. Standard: ein. Deaktiviere dies nur, wenn Partikel unabhängig von der Tiefe immer im Vordergrund erscheinen sollen — was selten gewünscht ist.
