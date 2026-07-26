# docs

Design and math references for the Vinv monorepo. These explain *how the
pipeline reasons* — the engines themselves are documented in each package's
own `README.md`.

| Document | What it covers | Who it's for |
| --- | --- | --- |
| [learning.md](learning.md) | The reward, propensity, and gating math that actually ships — every claim carries a `file:line` reference, plus measured off-policy results on this repo's own telemetry. | **Start here.** Anyone who wants to understand how Vinv learns from episodes. |
| [optimization-ontology.md](optimization-ontology.md) | The concept graph behind the optimization loop (detection → board → dispatch → verdict → learning): every node is a real on-disk artifact with its writers, readers, and expiry rule. | Contributors working on the optimization pipeline, or agents walking a repo's optimization state. |
| [testing-ontology.md](testing-ontology.md) | The concept graph behind behavioral testing: what artifacts must exist, what produces each, and the top-to-bottom walk order — framework-agnostic. | Contributors working on `exerciser`/identification, or agents reasoning about test coverage. |

`learning.md` is the entry point; the two ontology documents are walkable maps
of the on-disk artifacts each loop reads and writes.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
