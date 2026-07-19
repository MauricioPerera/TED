---
type: Concept
title: Arquitectura TED — mapa de modulos
description: Que modulo de src/ implementa cada seccion de la spec, para enlazar desde los contratos.
tags: ['arquitectura', 'ted']
---

# Arquitectura TED — mapa de modulos

Fuente normativa: [`ticket-agent-spec.md`](../../ticket-agent-spec.md) (TED 0.1). Este nodo solo
mapea seccion -> modulo, no repite el contenido de la spec (los contratos deben enlazar a la spec
directamente, no a este archivo, salvo cuando necesiten el mapeo).

| Modulo | Secciones de la spec | Responsabilidad |
|---|---|---|
| `src/types.ts` | S3, S4.2-4.3, S6.1, S11.4, S12.3 | Tipos compartidos (sin logica) |
| `src/crypto` | S5 | Ed25519 (atestacion), HMAC (transporte), SHA-256 (contenido) |
| `src/store` | S3, S7.2, S7.3 (ledger) | SQLite embebido: CAS+TTL, fencing token, ledger `declared/attempted/confirmed` |
| `src/bundle` | S4 | Lectura/escritura del directorio del ticket, frontmatter OKF, verificacion de hashes |
| `src/constraints` | S12 | Evaluador determinista permit/deny/error sobre {params, facts, ledger} |
| `src/state-machine` | S6 | 11 aristas (9 nominales + 2 encontradas al construir el orquestador, ver ted-state-machine.md), actor/credencial por arista |
| `src/attestation` | S5, S10.1 | Cadena de verificacion de atestacion + CRL |
| `src/shim` | S11 | Motor de mediacion (11 pasos de S11.2); no expone transporte MCP real, ver docs/reports/conformance.md item 5 |
| `src/escalation` | S13.1 | Disparadores duros, computados fuera del modelo |
| `src/orchestrator` | S6.3 (`pending -> leased`), Apendice A | Cadena de verificacion completa + ensamblado del shim + invocacion del agente (tipo `Agent`, inyectado; el mock de referencia vive en tests/e2e, no en un modulo `src/` propio) |

Partición de estado (decisión que gobierna todo lo demás, S3): `src/bundle` es dueño de lo firmado
e inmutable; `src/store` es dueño de lo disputado. Ningún módulo debe decidir un flujo de ejecución
leyendo `projected_*` del bundle — eso es solo informativo.
