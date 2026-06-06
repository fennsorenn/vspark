# Materialien {#materials}

Ein Material steuert, wie eine Oberfläche aussieht: ihre Farbe, Glanz, Transparenz und wie sie auf Szenenlichter reagiert. Jedes Material eines geladenen VRM-Avatars kann im Bereich **Material** des Eigenschaften-Panels unabhängig konfiguriert werden.

## Material-Modus {#mode}

Der **Shader**-Schalter (MToon / PBR / APBR) legt das Rendering-Modell für ein Material fest.

- **MToon** — Toon/Anime-Schattierung. Ignoriert die meisten Szenenlichter und Umgebungsreflexionen; stattdessen wird eine eingebaute Schattenfarbe verwendet, damit die Rückseite des Avatars nie vollständig schwarz wird. Dies ist der Standard für VRM-Dateien. Verwende diesen Modus, wenn du einen gezeichneten, illustrativen Look möchtest, der sich mit deinem Licht-Rig nicht verändert.
- **PBR** — physikalisch basiertes Rendering (`MeshStandardMaterial`). Reagiert auf Szenenlichter und Umgebungsintensität. Eine Fläche, die von deinem Hauptlicht abgewandt ist, wird entsprechend dunkler. Verwende es, wenn du realistischen Lichtabfall, Schatten und Reflexionen möchtest. Hinweis: Ohne Lichter in Reichweite wirkt der Avatar sehr dunkel.
- **APBR** — erweitertes physikalisches Rendering (`MeshPhysicalMaterial`). Eine strikte Obermenge von PBR. Rendert mit seinen Standardwerten identisch zu PBR und unterscheidet sich erst, wenn du einen seiner zusätzlichen Lobes (Clearcoat, Sheen, Transmission, Iridescence, Anisotropy) erhöhst. Verwende es, wenn PBR nicht ausreicht — für Glas, Stoffe, Metallic-Flake-Lack und ähnliche Effekte.

Die MToon-Schaltfläche ist für Materialien deaktiviert, die ursprünglich nicht als MToon erstellt wurden (native PBR/Standard-Materialien können nicht in Toon-Shading umgewandelt werden).

## Grundfarbe {#basecolor}

Die Hauptfarbe der Oberfläche. Klicke auf das Farbfeld, um den Farbwähler zu öffnen. Gilt in allen drei Shader-Modi. In MToon ist dies die beleuchtete Seite; in PBR/APBR ist es der Albedo-Wert, der in die physikalisch basierte Berechnung einfließt. Wenn das VRM eine Farbtextur enthält, wirkt die Grundfarbe als Tönung, die auf die Textur multipliziert wird — Weiß lässt die Textur unverändert.

## Metallizität & Rauheit {#metalrough}

Verfügbar in den Modi **PBR und APBR**.

- **Rauheit** (0–1, Standard `0,9`) — steuert, wie verschwommen oder scharf Oberflächenreflexionen sind. `0` ist eine spiegelglatte Oberfläche; `1` ist vollständig diffus ohne sichtbare Spiegellichter. Die meisten VRM-Modelle im Anime-Stil sehen zwischen `0,7` und `1,0` am besten aus. Niedrigere Werte lassen die Oberfläche sichtbar glänzend erscheinen.
- **Metallizität** (0–1, Standard `0`) — steuert, ob die Oberfläche wie ein Leiter (Metall) oder ein Isolator (die meisten organischen Materialien) verhält. Bei `0` ist die Oberfläche nicht metallisch: Sie reflektiert mit weißem Ton und behält die Grundfarbe als Diffus. Bei `1` ist die Oberfläche vollständig metallisch: Sie reflektiert mit dem Grundfarb-Ton und hat keine Diffus-Komponente. Zwischenwerte sind generell nicht physikalisch korrekt; verwende in den meisten Fällen `0` oder `1`.

## Emissiv {#emissive}

Verfügbar in **allen drei Modi**.

- **Emissive Farbe** — die Farbe, mit der die Oberfläche leuchtet. Schwarz (Standard) bedeutet kein Leuchten. Setze eine Farbe, damit die Oberfläche unabhängig von der Lichtplatzierung selbst beleuchtet wirkt.
- **Emissive Intensität** (0–5, Standard `0`) — multipliziert die emissive Farbe. Bei `0` hat die emissive Farbe keine Wirkung. Werte über `1` erzeugen ein helles, ausgebranntes Leuchten, wenn Bloom-Effekte an der Kamera aktiviert sind.

## Erweiterte APBR-Lobes {#advanced}

Diese Steuerungen sind nur verfügbar, wenn der Shader auf **APBR** eingestellt ist. Sie sind unter einem ein-/ausklappbaren Bereich **Erweitert** gruppiert. Jeder Lobe hat den Standardwert null (aus) und rendert identisch zu PBR, bis er erhöht wird.

- **Spekulare Intensität** (0–1) — Stärke einer nicht-metallischen Spekularlicht-Schicht, unabhängig von der Metallizität. Beim Standard `1` entspricht dies dem normalen Fresnel-Verhalten; niedrigere Werte unterdrücken das Spekularlicht.
- **Spekulare Tönung** — Farbe dieser Spekularlicht-Schicht. Standard Weiß. Eine Tönung verschiebt die Farbe der Reflexionen auf nicht-metallischen Oberflächen.
- **Clearcoat** (0–1) — fügt eine zweite transparente Lackschicht über der Basisoberfläche hinzu, wie Nagellack oder Autolack. `0` ist aus; `1` ist ein vollständiger Hochglanzlack.
- **Clearcoat-Rauheit** (0–1) — Rauheit der Clearcoat-Schicht, unabhängig von der Basis-Rauheit darunter.
- **Sheen** (0–1) — ein weicher retroreflektiver Schimmer in streifenden Winkeln, für Stoff und Samt. `0` ist aus.
- **Sheen-Rauheit** (0–1) — Streuung des Sheen-Spiegellichts. Hohe Werte ergeben einen breiteren, weicheren Stoff-Look.
- **Sheen-Farbe** — Tönung des Sheen-Spiegellichts. Standard Weiß.
- **Transmission** (0–1) — wie viel Licht durch die Oberfläche fällt, damit sie wie Glas oder durchsichtiger Kunststoff wirkt. `0` ist vollständig undurchsichtig; `1` ist vollständig transmissiv. Kombiniere dies mit dem IOR-Parameter für genaue Brechung.
- **Dicke** (0–5) — ungefähre Tiefe des transmissiven Volumens in Welteinheiten. Beeinflusst, wie Abschwächung und Brechung durch das Material akkumulieren. Hat keine sichtbare Wirkung ohne Transmission über null.
- **IOR** (1–2,333) — Brechungsindex, der steuert, wie stark Licht beim Eintritt in das transmissive Material gebogen wird. Wasser liegt bei etwa `1,33`; Glas bei etwa `1,5`; Diamant bei etwa `2,4`. Standard ist der neutrale three.js-Wert.
- **Abschwächungsfarbe** — die Farbe, die das Material beim Durchgang des Lichts durch sein Volumen absorbiert. Standard Weiß (keine Absorption). Eine rote Abschwächung tönt das transmittierte Licht rot.
- **Abschwächungsdistanz** (0–5) — wie weit (in Welteinheiten) Licht zurücklegt, bevor es die Abschwächungsfarbe erreicht. `0` deaktiviert die Volumenabschwächung. Größere Werte bedeuten, dass die Farbe bei einem dicken Objekt langsamer aufgebaut wird.
- **Irideszenz** (0–1) — Dünnfilm-Interferenz, die regenbogenartige Farbverschiebungen erzeugt, die sich je nach Betrachtungswinkel ändern, wie Seifenblasen oder Ölflecken. `0` ist aus.
- **Irideszenz-IOR** (1–2,333) — Brechungsindex für den irideszenten Dünnfilm. Beeinflusst, welche Farbtöne bei welchen Winkeln erscheinen.
- **Anisotropie** (0–1) — streckt Spiegellichter in der Tangentialrichtung der Oberfläche und erzeugt gebürstete Metall- oder haarähnliche Streifen. `0` ist isotrop (runde Spiegellichter).

## Umgebungsintensität {#env}

Verfügbar in den Modi **PBR und APBR**.

**Umgebungsintensität** (0–3, Standard `1`) — ein materialspezifischer Multiplikator auf den Beitrag der Umgebungskarte (HDRI). Die Umgebungsintensität auf Szenenebene wird pro Kamera eingestellt; dieser Regler skaliert sie zusätzlich für dieses einzelne Material. Bei `1` erhält das Material die volle Szenenumgebung. Bei `0` ignoriert es die Umgebung vollständig und verlässt sich ausschließlich auf platzierte Szenenlichter. Werte über `1` erhellen Reflexionen über die Einstellung auf Szenenebene hinaus.
