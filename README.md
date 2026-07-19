# TED — Tickets de Ejecución Diferida para Agentes

Implementación de referencia de [TED 0.1](ticket-agent-spec.md), construida con la metodología
[KDD](https://github.com/MauricioPerera/KDD) (OKF + CCDD). Ver [DEFINITION.md](DEFINITION.md) para
alcance y arquitectura, [knowledge/architecture/overview.md](knowledge/architecture/overview.md)
para el mapa spec→módulo, y [.agents/AGENTS.md](.agents/AGENTS.md) para las reglas del repo.

## Estado

Conformidad mínima (§15 de la spec) completa: los 9 módulos (`crypto`, `store`, `bundle`,
`constraints`, `state-machine`, `attestation`, `escalation`, `shim`, `orchestrator`) están
implementados y verificados, conectados end-to-end vía `orchestrator.handleCallback`. Checklist
punto por punto, con evidencia de test, en
[docs/reports/conformance.md](docs/reports/conformance.md).

108 tests (100 unitarios + 8 end-to-end con bundles reales firmados en disco), corridos dos veces
para determinismo, `tsc --noEmit` limpio, gate de complejidad en verde. Fuera de alcance: los
ítems RECOMENDADO de la spec (juez, retrieval por grafo, compactador) y un agente T2 real (se usa
un agente mock determinista) — ver [DEFINITION.md](DEFINITION.md), "Fuera de alcance".

## Desarrollo

```
npm install
npm run typecheck
npm test
python scripts/validate_contracts.py knowledge/contracts
```

Requiere Node.js >= 24 (usa `node:sqlite` y ejecución nativa de TypeScript, sin paso de build) y
Python 3 (para el validador de contratos).
