<!-- Referencia: knowledge/validacion.md, DEFINITION.md, docs/reports/conformance.md -->

## Qué hace este PR

<1-3 líneas: qué problema cierra, no cómo.>

## Contrato(s) relacionado(s)

<link a `knowledge/contracts/<task>.md`, o "N/A" si es un cambio que no sigue el flujo de task
contract (ej. un fix de doc, un ajuste de CI).>

## Evidencia de verificación

<Comando real corrido + resultado pegado. No alcanza con "lo probé y anda".>

- [ ] `npm run typecheck` — sin errores.
- [ ] `npm test` — verde (corrido dos veces si el cambio toca lógica concurrente/estado).
- [ ] `python scripts/validate_contracts.py knowledge/contracts` — 0 errores.
- [ ] Si el PR toca un contrato: `tests_sha256` re-sellado (si el oráculo cambió) y el archivo de
      tests está en este mismo diff.
- [ ] Si el PR fue producido por un agente delegado: diff dentro de `touch_only` del contrato (o
      justificado en esta descripción si lo excede).
- [ ] Si el PR agrega/cambia un módulo relevante a la conformidad §15: `docs/reports/conformance.md`
      actualizado.

## Checklist antes de pedir review

- [ ] CI verde en ambos legs (`ubuntu-latest` + `windows-latest`).
- [ ] Sin secretos ni claves reales en el diff (revisado a mano — este repo no tiene scanner
      automático de secretos).
- [ ] `DEFINITION.md` sigue reflejando el alcance real si este PR lo cambia.
