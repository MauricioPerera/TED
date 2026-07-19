---
type: Concept
title: Validación (subconjunto pragmático)
description: Qué gates existen en este proyecto y cuándo corren.
tags: ['ccdd', 'gate', 'validacion']
---

# Validación

Este proyecto NO clona el tooling completo del template KDD (que incluye ~12 scripts opcionales:
`validate_okf.py`, `validate_specs.py`, `assemble_context.py`, `preflight.py`, `audit_seals.py`,
etc.). Clonar todo eso sin necesidad concreta sería alcance no pedido. Lo que sí existe:

## Nivel 1 — obligatorio, sin LLM, sin red

```
python scripts/validate_contracts.py knowledge/contracts
```

Valida frontmatter, secciones obligatorias, el sello `tests_sha256` del oráculo congelado, y
`touch_only`. Un contrato no pasa a `implemented` sin esto en verde.

Además, el `test_command` declarado en cada contrato debe correr en verde (lo verifica el PM al
integrar, no solo el dev).

## Nivel 2 — gate MCP `ccdd-complexity`, lo corre el PM

- `lint_task_contract`: mismo lint que Nivel 1 más reglas adicionales (intent atómico, firma
  parseable, regla de parada).
- `measure_complexity`: ciclomática / anidamiento / parámetros / longitud por función, con backend
  TypeScript (tree-sitter).
- `run_integration_gate`: gatea un contrato ya en disco contra los archivos reales del repo.

Por doctrina (`pm-glm-ccdd`), el Nivel 2 lo corre el PM sobre el entregable del dev, no el dev
mismo — evita darle al dev efímero el MCP completo por una tarea acotada.

## Precedencia del budget

Con Nivel 2 disponible, manda su config firmada: el `budget` del frontmatter del contrato solo
puede ser `<=` ese techo. Sin Nivel 2, el `budget` del frontmatter es declarativo (el validador de
Nivel 1 solo verifica que esté presente).
