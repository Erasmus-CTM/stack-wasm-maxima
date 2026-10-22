```{math-exercise}
#| label: week3-paper-b-rank
#| caption: Rang og pivotkolonner for B
#| mode: custom
#| partial-credit: true
#| field-labels: Rang
#| context: week3-paper-assessment-context
#| checker: |
#|   def check(response, symbols):
#|       rank_value = response["expressions"][0]
#|       P = response["inputs"]["PBrank"]["matrix"]
#|       B = Matrix([[1, 0, 1], [0, 1, 1], [1, 1, 2]])
#|       expected_pivots = [Integer(j + 1) for j in B.rref()[1]]
#|       submitted_pivots = list(P)
#|       pivot_status = [
#|           i < len(expected_pivots) and value == expected_pivots[i]
#|           for i, value in enumerate(submitted_pivots)
#|       ]
#|       pivot_score = sum(pivot_status) / max(len(expected_pivots), len(submitted_pivots), 1)
#|       score = (int(rank_value == B.rank()) + pivot_score) / 2
#|       return {
#|           "score": score,
#|           "show_score": False,
#|           "feedback": "" if score == 1 else "Rangen er antall pivoter. Kontroller både rangverdien, antallet pivotindekser og rekkefølgen deres.",
#|           "assessment": {"PBrank": {"columns": pivot_status}},
#|       }

Finn rangen og pivotkolonnene til $B$:

$\operatorname{rank}(B)=$ _[2]

Pivotkolonner, én indeks per kolonne:

$P_B=$ mat{name=PBrank, rows=1, cols=auto, initial-cols=1, min-cols=0, max-cols=3}
```

```{math-exercise}
#| label: week3-paper-b-null-basis
#| caption: Basis for nullrommet til B
#| mode: custom
#| context: week3-paper-assessment-context
#| checker: |
#|   def check(response, symbols):
#|       Z = response["inputs"]["ZB"]["matrix"]
#|       B = Matrix([[1, 0, 1], [0, 1, 1], [1, 1, 2]])
#|       result = assess_basis(
#|           Z,
#|           axis="columns",
#|           target_dimension=B.cols - B.rank(),
#|           belongs=lambda vector: Z.rows == B.cols and B * vector == zeros(B.rows, 1),
#|           name="ZB",
#|           space_name="nullrommet til B",
#|       )
#|       statuses = result["assessment"]["ZB"]["columns"]
#|       if result["score"] < 1:
#|           if "incorrect" in statuses:
#|               result["feedback"] = "En rød kolonne er null eller oppfyller ikke Bz=0."
#|           elif "dependent" in statuses:
#|               result["feedback"] = "De gule kolonnene ligger i nullrommet, men familien er lineært avhengig."
#|           elif statuses:
#|               result["feedback"] = "De grønne kolonnene er gyldige og uavhengige, men de spenner ennå ikke hele nullrommet."
#|           else:
#|               result["feedback"] = "Legg til basisvektorer for nullrommet."
#|       return result

Oppgi en basis for nullrommet til $B$, med én basisvektor per kolonne. Enhver
basis godtas, og du må selv velge antallet kolonner:

$Z_B=$ mat{name=ZB, rows=3, cols=auto, initial-cols=1, min-cols=0, max-cols=3}
```

```{math-exercise}
#| label: week3-paper-c-null-basis
#| caption: Basis for nullrommet til C
#| mode: custom
#| context: week3-paper-assessment-context
#| checker: |
#|   def check(response, symbols):
#|       Z = response["inputs"]["ZC"]["matrix"]
#|       C = Matrix([[1, 2, 3], [2, 4, 6]])
#|       result = assess_basis(
#|           Z,
#|           axis="columns",
#|           target_dimension=C.cols - C.rank(),
#|           belongs=lambda vector: Z.rows == C.cols and C * vector == zeros(C.rows, 1),
#|           name="ZC",
#|           space_name="nullrommet til C",
#|       )
#|       statuses = result["assessment"]["ZC"]["columns"]
#|       if result["score"] < 1:
#|           if "incorrect" in statuses:
#|               result["feedback"] = "En rød kolonne er null eller oppfyller ikke Cz=0."
#|           elif "dependent" in statuses:
#|               result["feedback"] = "De gule kolonnene ligger i nullrommet, men familien er lineært avhengig."
#|           elif statuses:
#|               result["feedback"] = "De grønne kolonnene er gyldige og uavhengige, men de spenner ennå ikke hele nullrommet."
#|           else:
#|               result["feedback"] = "Legg til basisvektorer for nullrommet."
#|       return result

Oppgi en basis for nullrommet til $C$, med én basisvektor per kolonne. Enhver
basis godtas, og du må selv velge antallet kolonner:

$Z_C=$ mat{name=ZC, rows=3, cols=auto, initial-cols=1, min-cols=0, max-cols=3}
```
