# Timeline / Track-Clips {#track-clips}

Ein **Track-Clip** ist eine kurze aufgezeichnete Animation, die du einem Avatar,
einem Szenenknoten oder einer Compose-Ebene zuordnest. Wenn du einen Clip
abspielst, bewegt oder blendet vspark das Zielobjekt sanft entsprechend den
gesetzten Keyframes — ganz ohne Live-Motion-Capture. Clips befinden sich im
**Clips**-Tab im unteren Dock und werden im linken Dock über den Clips-Bereich
eines Knotens oder einer Ebene erstellt.

## Was sind Track-Clips? {#what}

Stell dir einen Track-Clip wie eine kurze Choreographie vor, die du speicherst
und jederzeit erneut abspielen kannst. Im Inneren jedes Clips befinden sich eine
oder mehrere **Spuren**, von denen jede eine einzelne Eigenschaft deines Avatars
oder der Szene steuert — zum Beispiel die X-Position einer Kamera oder die
Deckkraft einer Compose-Ebene. Der Clip hat eine feste **Dauer** (in Sekunden),
und du verteilst **Keyframes** entlang der Timeline, um zu beschreiben, wie sich
diese Eigenschaft im Laufe der Zeit verändert.

Du kannst mehrere Clips gleichzeitig auf denselben Knoten stapeln und für jeden
wählen, ob er den Normalwert **ersetzen** oder **addieren** soll. Mit
**Wiederholen** startet der Clip am Ende automatisch neu; mit **Autostart**
beginnt er bei jedem Start von vspark wieder.

## Spuren {#lanes}

Eine **Spur** steuert genau eine Eigenschaft eines Objekts. Wenn du auf
**+ Spur hinzufügen** klickst, wählst du:

- **Ziel** — einen Szenenknoten (Avatar, Kamera, Licht, Gruppe) oder eine
  Compose-Ebene.
- **Parameter** — welche Eigenschaft animiert werden soll. Bei Szenenknoten
  kannst du Position X/Y/Z, Rotation X/Y/Z oder Skalierung X/Y/Z animieren.
  Bei Compose-Ebenen stehen X, Y und Rotation zur Verfügung.

Jede Spur zeigt ihre animierten Werte als Kurve im Timeline-Bereich. Mit der
×-Schaltfläche in der Spurzeile entfernst du die Spur; die anderen Spuren
desselben Clips bleiben unverändert.

## Keyframes {#keyframes}

Ein **Keyframe** markiert einen Zeitpunkt, an dem eine Eigenschaft einen
bestimmten Wert hat. Zwischen zwei Keyframes interpoliert vspark (füllt die
Zwischenwerte aus) entsprechend dem gewählten **Easing**:

| Easing | Was es tut |
|--------|-----------|
| **linear** | Gleichmäßige, konstante Änderung von Keyframe zu Keyframe. |
| **Stufe** | Springt sofort zum neuen Wert, ohne Interpolation. |
| **Bezier** | Weiche, organische Kurve, die du durch Ziehen der Griffe formst. |

**Keyframe hinzufügen:** Ziehe den Abspielkopf (die senkrechte Linie) an den
gewünschten Zeitpunkt und klicke dann in den Timeline-Bereich einer Spur.
**Keyframe verschieben:** Ziehe ihn entlang der Spur nach links oder rechts.
**Keyframe löschen:** Rechtsklick und Löschen wählen, oder ihn auswählen und
die Schaltfläche „Keyframe löschen" im Inspektor unterhalb der Timeline
verwenden.

Klicke auf einen Keyframe, um ihn auszuwählen und den Inspektor zu öffnen, in
dem du einen genauen Wert eingeben, den Easing-Modus wählen und die
Bezier-Griffe zur Kurvenformung ziehen kannst.

## Transport — Abspielen, Pause, Stoppen, Fortsetzen {#transport}

Die Transport-Leiste oben in der Timeline steuert die Wiedergabe:

| Schaltfläche | Was sie tut |
|-------------|------------|
| **Abspielen** | Startet den Clip vom Anfang (oder von der aktuellen Abspielkopfposition). |
| **Pause** | Hält den Abspielkopf in der Mitte des Clips an; der Avatar behält die aktuelle Pose. |
| **Fortsetzen** | Setzt die Wiedergabe nach einer Pause fort. |
| **Stoppen** | Beendet die Wiedergabe und setzt den Avatar auf seine Ruhepose zurück. |

Der **Abspielkopf** zeigt die aktuelle Position in Sekunden. Ziehe ihn, um
jeden Moment des Clips in der Vorschau zu sehen, ohne ihn durchzuspielen.

Wenn **Wiederholen** aktiviert ist, startet der Clip nach dem letzten Keyframe
automatisch neu. Das ist nützlich für Idle-Animationen oder sich wiederholende
Overlays, die dauerhaft laufen sollen.

## Keyframes über die Eigenschaften-Leiste aufnehmen {#recording}

Die schnellste Methode, Keyframes hinzuzufügen, besteht darin, die gewünschten
Eigenschaften einzustellen, **während ein Clip ausgewählt ist**, und sie dann
mit den **Raute-Schaltflächen (◆)** im Eigenschaften-Panel zu markieren:

1. Wähle den Clip im Clips-Bereich des linken Docks aus (der Clip-Name wird
   hervorgehoben und das untere Dock wechselt zum Clips-Tab).
2. Ziehe den Abspielkopf in der Timeline an den gewünschten Aufnahmezeitpunkt.
3. Im **Eigenschaften**-Panel auf der rechten Seite den gewünschten Wert
   anpassen (zum Beispiel den X-Positions-Regler verschieben).
4. Klicke auf die **◆**-Schaltfläche neben dieser Eigenschaft. vspark erstellt
   eine Spur für diese Eigenschaft (sofern noch keine vorhanden ist) und setzt
   an der aktuellen Abspielkopfposition einen Keyframe mit dem eingestellten
   Wert.

Wiederhole die Schritte 2–4 zu verschiedenen Zeiten, um die Animation
aufzubauen. Du kannst die Keyframes anschließend verschieben, um das Timing
feinabzustimmen.
