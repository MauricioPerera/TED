# TED (Tickets de Ejecución Diferida para Agentes) — Definición

## Qué es

Una implementación de referencia de [TED 0.1](ticket-agent-spec.md): un sistema para que un agente
LLM ejecute acciones en un momento futuro, fuera de la sesión que las originó, componiendo MCP +
OKF + CCDD con una capa propia de asincronía, correlación y supervisión.

## Arquitectura

Dos particiones de estado (§3 de la spec):

- **Bundle** (disco, firmado, auditable): directorio del ticket — `ticket.md`, `instructions.md`,
  `effects.md`, `facts.md`, `context/`, `result.md`, `log.md`. Módulo `src/bundle`.
- **Store** (SQLite embebido, disputado, CAS+TTL): estado vivo de la máquina, lease, fencing token,
  ledger de efectos. Módulo `src/store`.

Componentes por encima de la partición:

- `src/crypto`: firmas de transporte (HMAC), contenido (SHA-256), atestación (Ed25519).
- `src/attestation`: cadena de verificación de atestación + CRL de revocaciones.
- `src/constraints`: lenguaje de constraints permit/deny/error (§12).
- `src/state-machine`: 7 estados, 11 transiciones, actor/credencial por arista (§6; corregido en
  spec 0.1.1 tras encontrar el hueco al construir el orquestador).
- `src/shim`: motor de mediación de efectos — mediación completa (§11); no expone un servidor MCP
  real, ver `docs/reports/conformance.md` ítem 5.
- `src/escalation`: disparadores duros de escalada, computados fuera del modelo (§13.1).
- `src/orchestrator`: cadena `pending → leased`, ensamblado del contrato de rehidratación,
  instanciación del agente ejecutor (mock en esta versión).
- `src/mock-agent`: agente T2 determinista para los tests end-to-end (ver Fuera de alcance).

## Capacidades objetivo

Los 10 puntos de conformidad mínima de la spec (§15):

1. Bundle conformante con OKF v0.1 + contrato de rehidratación validable.
2. Partición store/bundle: estado disputado solo en el store, nunca se decide sobre `projected_*`.
3. Máquina de estados con credencial de actor exigida por transición; los 4 terminales son
   irreversibles en el store.
4. Cadena de verificación completa (transporte → CAS → hash/atestación → CRL → vigencia) antes de
   instanciar el agente.
5. Shim que satisface mediación completa, inviolabilidad y verificabilidad; claves reales
   inaccesibles para el modelo.
6. Ledger `declared → attempted → confirmed` con fencing token en cada asiento.
7. Constraints evaluadas en entorno cerrado (parámetros, hechos firmados, ledger), con
   `permit`/`deny`/`error` y `now` como input registrado.
8. Toda respuesta de efecto de lectura validada contra su esquema declarado.
9. Disparadores duros de escalada computados fuera del modelo.
10. Atestación cubre la tupla completa de hashes + ventana, con mecanismo de revocación firmada.

## Por qué es un caso válido / motivación real

TED es una especificación teórica sin implementación de referencia. Construirla valida que la
especificación es implementable tal cual está escrita (o expone ambigüedades que la propia spec
debería resolver) y produce un artefacto reusable como base para orquestadores reales de agentes
diferidos.

## Fuera de alcance (v1)

- Ítems RECOMENDADO de la spec: retrieval por grafo (§10.2), compactador extractivo en cascada
  (§10.3), juez con asimetría de información (§11.5.3). Quedan documentados como pendientes, no
  implementados.
- Store distribuido (Redis u otro): se usa SQLite embebido (`node:sqlite`), suficiente para el
  propósito del spec (un registro chico por ticket + ledger).
- Agente ejecutor T2 real: los tests end-to-end usan un mock determinista que invoca tools del shim
  en secuencia fija — no se dispara un modelo real (ni se gastan tokens) en la suite automatizada.
  La integración con un modelo real queda fuera de esta versión.
- Multi-lenguaje / multi-agent-tool (Cursor, Windsurf, Copilot): solo se soporta Claude Code como
  consumidor de este repo KDD.
- Infraestructura de despliegue concreta (la spec misma lo declara no-objetivo en §1.2).
