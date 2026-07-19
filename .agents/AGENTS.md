# Reglas para Agentes de IA

Si eres un agente de IA interactuando con este repositorio, debes acatar las siguientes reglas:

1. **Metodología KDD Obligatoria**: Este repositorio utiliza Knowledge-Driven Development. Antes de
   escribir código, debes leer los contratos en `knowledge/contracts/` y la spec normativa de los
   nodos OKF en `knowledge/OKF-SPEC.md`. La spec de dominio (lo que se implementa) es
   [`ticket-agent-spec.md`](../ticket-agent-spec.md) (TED 0.1) en la raíz del repo.
2. **Carga la Skill Local**: skill `kdd-okf-ccdd-hybrid` en `.agents/skills/kdd-okf-ccdd-hybrid/SKILL.md`.
   Adóptala para generar y validar contratos híbridos OKF-CCDD.
3. **No dupliques contexto**: usa enlaces relativos a `knowledge/` o a `ticket-agent-spec.md#<sección>`
   en vez de repetir texto de la spec dentro de un contrato.
4. **Validación determinista (subconjunto pragmático de KDD, ver [knowledge/validacion.md](../knowledge/validacion.md)
   para el detalle):**
   - **Nivel 1 (obligatorio):** `python scripts/validate_contracts.py knowledge/contracts`
     (incluye el sello `tests_sha256`; sellar con `--hash`) + el `test_command` del contrato en verde.
   - **Nivel 2 (lo corre el PM, no el dev):** gate MCP `ccdd-complexity`
     (`lint_task_contract`, `measure_complexity`, `run_integration_gate`).
   Este proyecto NO clona el resto de scripts opcionales del template KDD (validate_okf.py,
   validate_specs.py, assemble_context.py, preflight.py, etc.) — están fuera de alcance porque el
   objetivo es implementar TED, no replicar el tooling completo del template. Si hacen falta más
   adelante, se agregan cuando haya una necesidad concreta, no antes.
5. **Precedencia del budget**: con gate MCP disponible manda su config firmada (`budget` del
   frontmatter solo puede ser <=); sin gate, `budget` es declarativo.
6. **Ciclo de vida del contrato**: `draft` → `validated` → `implemented` → `verified`. La evidencia va
   en `.agents/logs/<task>-REPORT.md` (gitignorado, local).
7. **Stack de este proyecto** (decidido con el usuario antes de arrancar, ver
   [`DEFINITION.md`](../DEFINITION.md)): TypeScript sobre Node.js nativo — sin paso de build para
   producción (Node ejecuta `.ts` directo vía type-stripping), `node:sqlite` embebido para el store
   (sin dependencias nativas), `node:crypto` para Ed25519/HMAC/SHA-256, `node:test` como test runner.
   Evita sintaxis TS que el type-stripping no puede borrar sin transformar (enums con valor,
   parameter properties, namespaces, `import =`) — solo `interface`/`type`/clases planas.

Este archivo es la fuente única de verdad para agentes de IA en este repo. Para un humano que revisa
lo que produjo un agente, ver el reporte de la tarea en `.agents/logs/` o `docs/reports/`.
