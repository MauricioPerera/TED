# TED — Tickets de Ejecución Diferida para Agentes

Implementación de referencia de [TED 0.1](ticket-agent-spec.md), construida con la metodología
[KDD](https://github.com/MauricioPerera/KDD) (OKF + CCDD). Ver [DEFINITION.md](DEFINITION.md) para
alcance y arquitectura, [knowledge/architecture/overview.md](knowledge/architecture/overview.md)
para el mapa spec→módulo, y [.agents/AGENTS.md](.agents/AGENTS.md) para las reglas del repo.

## Estado

En construcción. Checklist de conformidad mínima (§15 de la spec) en
[docs/reports/conformance.md](docs/reports/conformance.md) (se agrega en Batch 5).

## Desarrollo

```
npm install
npm run typecheck
npm test
python scripts/validate_contracts.py knowledge/contracts
```

Requiere Node.js >= 24 (usa `node:sqlite` y ejecución nativa de TypeScript, sin paso de build) y
Python 3 (para el validador de contratos).
