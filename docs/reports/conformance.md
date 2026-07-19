# Conformidad TED 0.1 — checklist §15

Estado de los 10 puntos de conformidad mínima de
[`ticket-agent-spec.md` §15](../../ticket-agent-spec.md#15-conformidad), con el módulo y la
evidencia de test que sustenta cada uno. Los 4 ítems RECOMENDADO (retrieval por grafo §10.2,
compactador extractivo §10.3, juez §11.5.3) están fuera de alcance — ver
[`DEFINITION.md`](../../DEFINITION.md), sección "Fuera de alcance".

| # | Requisito | Módulo(s) | Evidencia |
|---|---|---|---|
| 1 | Bundle conformante con OKF v0.1 + contrato de rehidratación validable | `src/bundle` | `tests/unit/bundle.test.ts` (round-trip de frontmatter, effects, facts); el contrato de rehidratación CCDD en sí (§8 de la spec) no se implementa como artefacto propio en esta versión — ver nota abajo |
| 2 | Partición store/bundle: estado disputado solo en el store, ninguna decisión lee `projected_*` | `src/store`, `src/bundle` | `src/orchestrator/index.ts` decide únicamente sobre lo que devuelve `store.acquireLease`/`store.transition` (nunca sobre `frontmatter.projectedState`); `tests/unit/store.test.ts` cubre el CAS en aislamiento |
| 3 | Máquina de estados con credencial de actor por transición; terminales irreversibles | `src/state-machine`, `src/store` | `tests/unit/state-machine.test.ts` (11 aristas, actor exacto por arista) + `tests/unit/store.test.ts` ("transition out of a terminal state always fails") |
| 4 | Cadena de verificación completa antes de instanciar el agente, incluyendo CRL | `src/orchestrator`, `src/attestation` | `tests/unit/orchestrator.test.ts` + `tests/e2e/full-cycle.test.ts` (transporte → CAS → atestación+CRL+vigencia → shim → agente, en ese orden; ningún test permite que el agente corra antes de `"proceed"`) |
| 5 | Shim con mediación completa/inviolabilidad/verificabilidad; claves reales inaccesibles para el modelo | `src/shim` | `tests/unit/shim.test.ts` (13 tests: resolución cerrada, ledger, constraints, fencing token, lecturas tipadas). El shim de referencia es el motor de mediación (no un servidor MCP real conectado por stdio) — ver nota abajo |
| 6 | Ledger `declared → attempted → confirmed` con fencing token por asiento | `src/store` | `tests/unit/store.test.ts` (idempotencia de `ledgerMarkAttempted` sobre `confirmed`, rechazo de fencing token vencido) |
| 7 | Constraints en entorno cerrado, `permit`/`deny`/`error`, `now` como input registrado | `src/constraints` | `tests/unit/constraints.test.ts` (13 tests: entorno cerrado que no compila fuera de `params/facts/ledger`, `now` nunca leído del reloj, auditoría reproducible) |
| 8 | Respuesta de efecto de lectura validada contra su esquema declarado | `src/shim` | `tests/unit/shim.test.ts` ("read effects validate the response against the declared schema") |
| 9 | Disparadores duros de escalada computados fuera del modelo | `src/escalation`, `src/shim` | `tests/unit/escalation.test.ts` + `tests/unit/shim.test.ts` (constraint-error, unknown-tool, max-invocations, repeated-deny) |
| 10 | Atestación cubre la tupla completa de hashes + ventana; mecanismo de revocación firmada | `src/attestation`, `src/crypto` | `tests/unit/attestation.test.ts` (firma sobre la tupla completa incl. hash del manifiesto de corpus, CRL con firma real, orden CRL-antes-que-vigencia) + `tests/e2e/full-cycle.test.ts` ("a ticket cancelled via a real signed CRL entry") |

## Notas sobre el ítem 1 (contrato de rehidratación CCDD, §8)

La spec describe un contrato YAML explícito (`ccdd_version`, `slots` con prioridad/compaction,
`guardrails`) que un ensamblador usaría para construir la ventana del modelo real en T2. Esta
versión de referencia no lo implementa como artefacto independiente porque el agente T2 es un
mock determinista (`Agent` en `src/orchestrator`, ver `DEFINITION.md` "Fuera de alcance") que no
consume una ventana de contexto — no hay ensamblador de prompt que gobernar. El *contenido* que
el contrato gobernaría (slots firmados de máxima prioridad, contexto dinámico resumible) sí existe
como datos reales: `instructions.md`/`effects.md`/`facts.md` firmados (`src/bundle`,
`src/attestation`) y `context/` con su manifiesto (`src/bundle`). Conectar esto a un ensamblador
de prompt real es trabajo futuro, no cubierto por esta implementación de referencia.

## Notas sobre el ítem 5 (shim como servidor MCP real, §11.1)

El shim implementado (`src/shim/EffectsShim`) es el **motor de mediación**: aplica exactamente la
secuencia de 11 pasos de §11.2 (resolución, ledger, constraints, fencing token, ejecución,
validación de lecturas) contra un manifiesto cerrado. Lo que no se implementa es la capa de
transporte MCP (`@modelcontextprotocol/sdk`, ya instalado como dependencia pero sin usar): exponer
`EffectsShim.invoke` como tools de un servidor MCP real conectado a un cliente por stdio o
transporte en memoria. Dado que el agente T2 de esta versión es un mock que llama `invoke()`
directamente (no un modelo real hablando el protocolo MCP), esa capa de transporte no tenía
consumidor real que la ejercitara — agregarla sin un cliente MCP real habría sido una pieza sin
uso demostrable. La propiedad de seguridad que el ítem 5 pide (mediación completa, claves
inaccesibles) está garantizada por el motor: el `execute` inyectado en `EffectsShim` es la única
puerta hacia el mundo real, y el agente nunca la ve ni la toca directamente.

## Residuos irreducibles (§14) — estado en esta implementación

- **§14.1 (envenenamiento en T0)**: no mitigado por diseño — una firma solo garantiza integridad,
  no verdad. Fuera de alcance de código (es una propiedad del proceso humano de creación).
- **§14.2 (steering semántico)**: no aplica de la misma forma sin un modelo real interpretando
  `instructions.md`; el agente mock no es persuadible. Residuo que reaparece si se conecta un
  modelo real.
- **§14.3 (tensión con la frescura)**: resuelto tal como prescribe la spec — los únicos datos
  vivos que entran son el trigger payload (mínimo) y los efectos `kind: "read"` tipados
  (`src/shim`), nunca un re-scan del corpus firmado.
- **§14.4 (ambigüedad no reconciliable)**: `src/escalation` clasifica `ambiguous_effect` con
  `reconciliationPossible: false` como disparador duro; el mecanismo de reconciliación real
  (consultar un sistema externo antes de decidir) no está implementado porque no hay sistemas
  externos reales en esta versión — es un residuo documentado, no resuelto.
