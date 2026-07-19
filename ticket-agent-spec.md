# Tickets de Ejecución Diferida para Agentes (TED)

**Versión 0.1.1 — Borrador**

TED especifica un sistema para que un agente basado en LLM ejecute acciones en un momento futuro, fuera de la sesión que las originó, sin mantener al modelo vivo entre la creación de la intención y su cumplimiento. El sistema compone tres piezas existentes sin modificar ninguna: MCP como interfaz sincrónica modelo-herramientas dentro de una sesión, OKF como formato del conocimiento en reposo, y CCDD como contrato del conocimiento en inferencia. La asincronía, la correlación y la supervisión viven en una capa propia, especificada acá.

Este documento es teórico: define componentes, invariantes y semánticas, no tecnologías concretas de implementación.

---

## 1. Motivación

MCP no tiene wake-up nativo: el flujo de control lo posee el host, el servidor es pasivo, y no existe mecanismo para que un servidor inicie una inferencia desde cero. Sampling invierte parcialmente la dirección, pero solo dentro de una sesión viva. Para scheduling real, la responsabilidad de despertar al modelo debe moverse fuera del protocolo.

TED adopta el patrón de ejecución asíncrona con correlación (estructuralmente idéntico a los webhooks de confirmación de pago): la intención se especifica en T0 con el modelo presente, el cumplimiento ocurre en T1 sin modelo, y en T2 un orquestador instancia un agente nuevo que hereda contexto vía el ticket. El modelo se acepta como efímero y stateless; la continuidad vive en el ticket y en el orquestador.

El movimiento arquitectónico central es la inversión de jerarquía. En MCP estándar la pila es usuario, host/modelo, cliente MCP, servidor. En TED la pila es evento, orquestador, agente (modelo), tools. El orquestador pasa de componente subordinado a componente raíz que instancia hosts. El modelo deja de ser el loop de control y pasa a ser una función invocable: el loop de larga duración es código determinístico (barato, confiable, auditable) y la inferencia se invoca solo donde hace falta juicio.

### 1.1 Objetivos

1. Definir la máquina de estados del ticket con actores, credenciales y verificaciones explícitos por transición.
2. Garantizar semántica de efecto exactly-once componiendo entrega at-least-once con idempotencia.
3. Acotar el daño de un agente autónomo sin humano presente mediante un monitor de efectos y contratos firmados.
4. Declarar un régimen explícito para cada canal de entrada a la ventana del modelo.
5. Nombrar con honestidad los residuos que ninguna firma cubre.

### 1.2 No-objetivos

- Prescribir infraestructura concreta (store, colas, runtime).
- Modificar los specs de MCP, OKF o CCDD.
- Eliminar la necesidad de juicio humano: TED lo reintroduce de forma controlada vía escalada, no lo suprime.

---

## 2. Terminología

Las palabras clave DEBE, NO DEBE, DEBERÍA, NO DEBERÍA y PUEDE se interpretan en el sentido de RFC 2119.

- **Ticket**: unidad de intención diferida. Un directorio OKF más un registro transaccional.
- **T0 / T1 / T2**: momento de creación de la intención / de cumplimiento del trigger / de ejecución del agente.
- **Creador**: humano o agente supervisor de T0. Posee la clave de atestación.
- **Sistema de cumplimiento**: el sistema externo que detecta o produce el trigger. Posee la clave de transporte.
- **Orquestador**: proceso supervisor que existe entre sesiones. Correlaciona callbacks con tickets, adquiere leases e instancia agentes.
- **Agente ejecutor**: la instancia de modelo despertada en T2. No es "el mismo" agente de T0: es un sucesor que hereda contexto vía el ticket.
- **Shim de efectos**: monitor de referencia que media todo efecto del agente sobre el mundo. Ver §11.
- **Compactador**: modelo auxiliar que resume contexto bajo contrato propio. Ver §10.4.
- **Juez**: modelo auxiliar opcional que evalúa invocaciones con asimetría de información deliberada. Ver §11.5.
- **Store**: almacenamiento transaccional con compare-and-swap (CAS) y TTL. Fuente de verdad del estado disputado.
- **Bundle**: el directorio OKF del ticket. Fuente de verdad de lo firmado y lo auditable.
- **Ledger de efectos**: registro en el store del estado por efecto (declared / attempted / confirmed).
- **Fencing token**: contador monotónico por ticket emitido en cada adquisición de lease.
- **Manifiesto de efectos**: enumeración cerrada y firmada de los efectos que el agente puede producir.
- **Atestación**: firma Ed25519 del creador sobre contenido más ventana de validez.
- **CRL**: lista de revocaciones firmadas que anulan atestaciones antes de su vencimiento.

---

## 3. Partición de estado

La decisión que gobierna todo lo demás: qué vive en el bundle y qué vive en el store.

**En el bundle** (todo lo que se firma y todo lo que se audita): instrucciones, manifiesto de efectos, atestación, contexto snapshot de T0, resultado final, historia proyectada en `log.md`. Todo esto es inmutable post-firma o append-only. Consecuencia: el bundle puede cachearse, replicarse y leerse sin coordinación, porque nada de lo que contiene se disputa.

**En el store** (todo lo que se disputa): estado vivo de la máquina, lease y su vencimiento, fencing token, contador de intentos, ledger de efectos. Son valores que múltiples orquestadores compiten por escribir con CAS.

Reglas normativas:

1. El frontmatter del ticket PUEDE proyectar el estado del store con prefijo `projected_`. Esa proyección es informativa y NO DEBE tratarse como autoritativa. Si bundle y store divergen, manda el store.
2. Todo cambio de estado DEBE ser una escritura CAS con token en el store, y DEBERÍA reflejarse como entrada en `log.md` como proyección posterior.
3. La contención vive entera en el store, que maneja exactamente un registro chico por ticket más el ledger.

---

## 4. Estructura del bundle

Un ticket es un directorio, no un archivo, porque sus partes tienen ciclos de vida y regímenes de firma distintos:

```
tickets/
├── index.md
├── log.md
├── attestations.json          # firmas de atestación, por ticket
├── revocations.json           # CRL: anulaciones firmadas
└── <fecha>-<hash>/
    ├── ticket.md              # concepto hub: intención + proyección
    ├── instructions.md        # slot crítico firmado, compaction none
    ├── effects.md             # manifiesto de efectos, firmado
    ├── facts.md               # hechos operativos firmados (ver §4.4)
    ├── context/
    │   ├── index.md
    │   └── *.md               # snapshot blando de T0
    ├── result.md              # escrito en T2; no existe antes
    └── log.md                 # proyección de la máquina de estados
```

El ID del directorio (fecha más hash corto) es ordenable, único, y el hash es la clave de correlación del sistema.

### 4.1 Tres regímenes, tres archivos

- `instructions.md` y `effects.md` se firman juntos y NO DEBEN cambiar jamás. Cambiarlos es re-atestar, es decir, crear una versión nueva con linaje explícito.
- `ticket.md` carga la proyección, que se actualiza en cada transición.
- `context/` es material blando que el retriever PUEDE resumir, bajo el régimen de §10.

### 4.2 El concepto hub: `ticket.md`

Frontmatter mínimo (conforme OKF §9, que tolera claves adicionales):

```yaml
---
type: Ticket
title: <título humano>
description: <una línea>
timestamp: <ISO 8601>

ccdd_provenance:
  author: <agent:... | human:...>
  generated_at: <ISO 8601>
  approved_by: <human:...>

ticket_id: <hash corto>
supersedes: <ticket_id | null>
superseded_by: <ticket_id | null>

trigger:
  kind: <external_callback | timer | condition>
  expected_from: <identidad del sistema autorizado>
  correlation_key: <ticket_id>

attestation:
  attested_by: <human:...>
  attested_at: <ISO 8601>
  valid_until: <ISO 8601>
  signature_ref: /tickets/attestations.json#<ticket_id>

projected_state: <estado>
projected_attempts: <n>
projected_as_of: <ISO 8601>
---
```

Decisiones normativas:

1. `supersedes` / `superseded_by` implementan la irreversibilidad de terminales (§6.3): los estados terminales nunca mutan; la continuación es un ticket nuevo con linaje navegable en ambas direcciones.
2. `trigger.expected_from` declara quién tiene derecho a hablar de este ticket. La firma de transporte valida quién habla; este campo valida su autoridad sobre este ticket. El orquestador DEBE rechazar callbacks firmados por sistemas legítimos pero no autorizados para el ticket.

### 4.3 El manifiesto de efectos: `effects.md`

Enumeración cerrada de los efectos externos que el agente puede producir. Por cada efecto:

```yaml
## <effect_id>
- tool: <operación real subyacente>
- constraints: <expresiones del lenguaje de §12>
- idempotency_key: <ticket_id>:<effect_id>
- max_invocations: <n>
- escalation: <política de disparadores para este efecto, ver §13.2>
- kind: <write | read>
- response_schema: <esquema tipado; obligatorio si kind = read>
```

Propiedades normativas:

1. **Lista blanca cerrada**: todo efecto no enumerado está prohibido. El shim DEBE rechazar cualquier invocación cuya clave no derive del manifiesto.
2. **Claves derivadas por regla fija** (`ticket_id:effect_id`): el agente NO DEBE poder improvisar claves distintas entre reintentos. Las claves se precomputan o son derivables determinísticamente.
3. **Constraints evaluables solo contra material firmado**: ver §4.4 y §12. Una constraint que referencia material no firmado no es una constraint, es una sugerencia, y NO DEBE aceptarse en el lint.

### 4.4 Hechos operativos: `facts.md`

El contexto se parte en dos regímenes:

- **Hechos operativos** (destinatarios, montos, IDs, saldos): valores que las constraints del manifiesto referencian. Viven en `facts.md`, firmado individualmente. El shim evalúa constraints contra este archivo, nunca contra el slot dinámico.
- **Contexto narrativo blando** (resúmenes de conversación, notas): fluye por el retriever y solo informa el juicio del modelo. No fundamenta constraints.

Motivación: si las constraints se evaluaran contra contexto recuperado, una inyección no necesitaría expandir efectos; le bastaría torcer el parámetro que la constraint consulta. Este archivo cierra ese agujero.

---

## 5. Firmas

El sistema usa tres firmas ortogonales con roles y vidas distintos. Un atacante debe comprometer las tres para lograr que el agente ejecute algo alterado, viejo y no autorizado.

1. **Firma de transporte** (HMAC o Ed25519 más timestamp, sobre el callback): autentica el evento "despertá". Vida corta. El receptor DEBE rechazar mensajes fuera de una ventana de tolerancia temporal (anti-replay). El replay dentro de la ventana lo absorbe la deduplicación por ticket_id; el replay fuera, la verificación temporal. Las dos capas se cubren mutuamente por diseño.
2. **Firma de contenido** (SHA-256 de los slots críticos, persistida junto a la atestación): garantiza que instrucciones, manifiesto y hechos llegan intactos a la ventana del modelo. Vida larga, cubre T0 a T2. La verificación es en el punto de consumo, contra la raíz de confianza, no en cada salto: el canal puede ser hostil, el storage compartido, el retriever buggy.
3. **Firma de atestación** (Ed25519 sobre la tupla `ticket_id : sha(instructions.md) : sha(effects.md) : sha(facts.md) : sha(manifiesto de corpus) : attested_at : valid_until`): garantiza que la intención sigue autorizada. Cubre la dimensión temporal que las otras dos ignoran. Firmar todos los hashes juntos impide el ataque de mezcla (instrucciones de un ticket con efectos de otro).

Principios de diseño:

- **El canal es un timbre, no un sobre**: el mensaje de transporte DEBERÍA contener solo `ticket_id`, estado nuevo, timestamp y firma. Todo lo sustantivo vive en el bundle verificado por las firmas 2 y 3. Minimizar el contenido del canal minimiza la superficie de la firma más débil.
- **Revocación**: la atestación con `valid_until` no puede acortarse sin mecanismo adicional, porque la firma original sigue siendo válida hasta vencer. `revocations.json` es el CRL: entradas firmadas por el creador que anulan atestaciones por ticket_id. El orquestador DEBE consultarlo en toda cadena de verificación. Sin CRL, cancelar es un deseo hasta que la ventana venza sola.
- **Manifiesto de corpus**: la atestación DEBE incluir el hash de la lista de archivos de `context/` con sus SHA-256 (ver §10.1).

---

## 6. Máquina de estados

Siete estados, once transiciones. Cada arista tiene actor, credencial y verificación explícitos.
(Corregido en 0.1.1: la cuenta original de nueve solo nombraba explícitamente una de las tres
formas en que puede fallar el paso 3 de `pending → leased`; ver el cierre de §6.3 y la tabla.)

### 6.1 Estados

- `pending`: firmado, atestado, espera trigger.
- `leased`: un orquestador posee el lease con fencing token vigente; el agente puede estar ejecutando.
- `escalated`: congelado, espera decisión humana. No terminal.
- Terminales: `fulfilled` (efecto verificado), `failed` (con causa registrada), `expired` (ventana vencida), `cancelled` (revocado firmado).

### 6.2 Actores y credenciales

Cada clase de actor tiene su propia credencial, y ninguna transición es válida sin la credencial de su actor:

1. **Creador**: clave de atestación Ed25519. Único que da vida a un ticket y único que lo revoca.
2. **Sistema de cumplimiento**: clave de transporte. Solo puede decir "el trigger ocurrió". No puede alterar contenido ni estados.
3. **Orquestador**: fencing token vigente (capacidad efímera otorgada por el store vía CAS). Solo puede mover `leased` hacia adelante o escribir resultados.
4. **Reloj**: sin credencial; sus transiciones se derivan determinísticamente de datos ya firmados. Nadie dispara `expired`: se constata.

Propiedad de seguridad resultante: comprometer una credencial no alcanza para completar un flujo malicioso. Solo la clave del creador permite inyectar intención nueva; es la raíz a custodiar.

### 6.3 Transiciones

**create → pending** (creador). El ticket no existe hasta cumplirse atómicamente: contenido escrito con hashes persistidos, atestación firmada cubriendo contenido más ventana, presupuesto de efectos enumerado con claves precomputadas. Un ticket sin las tres cosas es un draft y el lint DEBE rechazarlo.

**pending → leased** (orquestador, gatillado por callback). Cadena de verificación en orden estricto, de lo barato a lo caro:

1. Firma de transporte y ventana temporal del callback.
2. CAS `pending → leased` emitiendo fencing token N+1 con vencimiento. Si el CAS falla porque el estado ya no es `pending`, el callback es duplicado y se absorbe con éxito silencioso (respondiendo OK: responder error a un duplicado genera más reintentos).
3. Con lease adquirido: hash de contenido contra la atestación, consulta al CRL, verificación de vigencia y frescura.
4. Solo si todo pasa: assemble del contrato CCDD e instanciación del agente.

El orden importa: el CAS antes de las verificaciones caras evita trabajo paralelo redundante; las verificaciones criptográficas antes de la inferencia garantizan que nunca se gasta un token de modelo en un ticket alterado o vencido. Las tres verificaciones del paso 3 fallan **desde `leased`, no desde `pending`**: el CAS del paso 2 ya movió el ticket ahí antes de que el paso 3 se ejecute. Hash inválido va a `leased → failed` con causa `integrity-violated` y NO DEBE reintentarse jamás (reintentar una violación de integridad es un vector de ataque, no una recuperación); un hit del CRL va a `leased → cancelled`; atestación vencida va a `leased → expired`.

**leased → fulfilled** (orquestador con token vigente). Resultado escrito junto al token; el store DEBE rechazar escrituras con token no vigente.

**leased → failed** (orquestador con token). Causas: abort del agente, guardrail disparado, presupuesto agotado, reintentos agotados. `failed` DEBE registrar causa, porque las causas tienen políticas de reintento opuestas.

**leased → pending** (reloj más el próximo orquestador que constata lease vencido). La transición que encarna at-least-once: no se sabe si el agente muerto ejecutó efectos. La vuelta a `pending` es segura si y solo si los efectos son dedupeables vía ledger (§8.3). Incrementa `attempts`.

**leased → escalated** (orquestador, a pedido del agente o por disparador duro). Congela el lease; nadie más puede tomar el ticket.

**escalated → pending** (creador, no orquestador). La decisión de continuar exige re-firmar: las instrucciones probablemente cambiaron y la ventana original quizás no aplica. Re-atestar crea una versión nueva con hash nuevo: el ticket que vuelve es criptográficamente distinguible del original. La historia no se reescribe; se extiende.

**escalated → cancelled**, **pending → cancelled** y **leased → cancelled** (creador, con revocación firmada asentada en el CRL). La tercera arista es la que el paso 3 de `pending → leased` recorre cuando encuentra un hit en el CRL: el ticket ya está en `leased` (CAS del paso 2), y la revocación que autoriza la transición ya fue firmada de antemano por el creador — no hace falta una firma nueva en el momento.

**pending → expired** y **leased → expired** (reloj). La primera se constata en el sweep periódico (higiene); la segunda, dentro de la cadena de verificación de `pending → leased` (paso 3), cuando el ticket ya está en `leased` y la ventana venció. Ninguna de las dos exige credencial: se derivan deterministicamente de datos ya firmados, igual que toda transición de `clock`. La verificación en el consumo es la que manda.

### Tabla de las 11 aristas

| Desde | Hacia | Actor |
|---|---|---|
| `pending` | `leased` | Sistema de cumplimiento |
| `leased` | `fulfilled` | Orquestador |
| `leased` | `failed` | Orquestador |
| `leased` | `pending` | Reloj |
| `leased` | `escalated` | Orquestador |
| `escalated` | `pending` | Creador |
| `escalated` | `cancelled` | Creador |
| `pending` | `cancelled` | Creador |
| `pending` | `expired` | Reloj |
| `leased` | `expired` | Reloj |
| `leased` | `cancelled` | Creador |

### 6.4 Invariantes

1. **Cuatro terminales, ninguno reversible**: el store DEBE rechazar cualquier CAS que salga de un terminal. La única resurrección legal es un ticket nuevo con `supersedes`.
2. **Techo de reintentos**: cada vuelta `leased → pending` incrementa `attempts`; superar `max_attempts` fuerza `failed` con causa `retry-exhausted`. Sin esto, un ticket veneno cicla para siempre. Equivalente de la dead letter queue.
3. **Store manda, bundle proyecta**: todo cambio de estado es CAS con token; `log.md` es proyección. Si divergen, manda el store.
4. **Monotonía del fencing token** por ticket: solo crece; toda escritura de resultado lo incluye. Convierte "el proceso viejo revivió" de catástrofe silenciosa en rechazo explícito.
5. **Ningún token de inferencia se gasta antes de completar la cadena de verificación**: el modelo es el recurso caro y el componente no determinista; todo lo determinista y barato va antes.

---

## 7. Semántica de entrega

### 7.1 El teorema

Sin transacciones distribuidas entre el store y el mundo externo (que no las soporta: no hay rollback de un mail enviado), no existe exactly-once en la ejecución. Solo existe exactly-once en el efecto, y se construye componiendo at-least-once con idempotencia. TED elige at-least-once deliberadamente y empuja la deduplicación a la capa de idempotencia. Los locks perfectos no son alternativa: el lock también queda huérfano si el proceso muere sosteniéndolo.

### 7.2 Lease con fencing token

El orquestador no marca `in_progress` para siempre: adquiere un lease con vencimiento vía CAS. Cada adquisición incrementa el fencing token. Si el orquestador A muere, su lease vence, B adquiere con token N+1, y si A revive tarde sus escrituras con token N son rechazadas.

### 7.3 Idempotencia en dos fronteras

**Frontera A (sistema → orquestador)**: el callback duplicado se deduplica por ticket_id vía el CAS de estado. Barata, ya implementada por §6.3.

**Frontera B (agente → mundo)**: aunque el agente se instancie una vez, internamente puede reintentar un tool call cuyo timeout fue un éxito lento. La solución: claves de idempotencia derivadas determinísticamente del ticket (`ticket_id:effect_id`), propagadas hacia abajo, con el sistema receptor (o el shim) deduplicando por clave.

**El ledger de efectos**: cada efecto tiene una sub-máquina `declared → attempted → confirmed` en el store. El asiento `attempted` (patrón outbox) se escribe antes de tocar el mundo; el `confirmed`, después, con hash del resultado. En un reintento post lease vencido, el sucesor recorre el ledger saltando lo confirmado. Sin este ledger, `leased → pending` es una fábrica de duplicados.

**El caso irreducible**: efectos contra sistemas sin soporte de claves de idempotencia. Dos opciones: envolver con registro propio (el outbox del ledger) o aceptar duplicación ocasional eligiendo efectos donde duplicar es tolerable. No hay tercera opción; es honesto diseñar sabiéndolo.

---

## 8. Rehidratación: el contrato CCDD del ticket

OKF gobierna el ticket en reposo entre T0 y T2; CCDD gobierna el acto de despertar. El contrato tipo:

```yaml
ccdd_version: "0.3"
contract:
  name: ticket-<id>
  budget:
    model: <modelo>
    max_tokens: <n>
    reserve_output: <n>
  slots:
    - id: ticket_instructions
      priority: 0
      source: { type: static, path: instructions.md, sign: true }
      compaction: none
      review_quorum: 2
    - id: effects_manifest
      priority: 1
      source: { type: static, path: effects.md, sign: true }
      compaction: none
    - id: signed_facts
      priority: 2
      source: { type: static, path: facts.md, sign: true }
      compaction: none
    - id: trigger_payload
      priority: 5
      source: { type: runtime }
      compaction: truncate
      max_tokens: 1000
    - id: world_context
      priority: 10
      source: { type: dynamic, provider: okf-retriever }
      compaction: summarize
      max_tokens: 6000
  guardrails:
    - id: no-secrets
      type: regex_deny
      on_fail: abort
    - id: effects-grounded
      type: reference_check
      on_fail: abort
```

El gradiente de severidad mapeado al ticket: lo firmado es intocable y de prioridad máxima (si el presupuesto aprieta, se sacrifica todo lo demás antes); el payload del trigger entra truncado porque el canal es un timbre; el contexto del mundo es lo único resumible.

Nota sobre `on_fail: abort` en el grounding: en la POC de knowledge base el mismo guardrail hace `reroute`. En un agente sin humano presente, un efecto que no puede fundamentarse en contexto firmado no se re-rutea a ver si sale mejor: se aborta y escala. Misma primitiva, política opuesta, dictada por la ausencia de supervisión.

---

## 9. Escritura para el sucesor

El agente de T2 no es el agente de T0: es una instancia nueva que hereda contexto vía el ticket. Consecuencias normativas:

1. Las instrucciones DEBEN ser autocontenidas, escritas para un lector sin memoria. El agente de T0 escribe para su sucesor, no asume que "él" estará ahí.
2. El juicio DEBERÍA empujarse a T0: toda decisión que puede tomarse cuando hay humano presente se toma entonces y se congela en la firma (ver §12.6.1).
3. Las instrucciones DEBEN dar permiso explícito y vocabulario concreto para escalar, y el criterio de éxito DEBE contar la escalada correcta como resultado correcto. Si las instrucciones tratan la escalada como fracaso, el agente aprende a bluffear la ambigüedad: el peor resultado posible. En un sistema sin humano presente, la honestidad del agente sobre sus límites es una propiedad de seguridad, y las propiedades de seguridad se escriben en el slot firmado, no se dejan a la inferencia.

---

## 10. Canales de entrada y el retriever

Principio rector: **no existe canal de entrada a la ventana sin régimen declarado**. Es la versión para LLMs de la mediación completa, aplicada a los bytes entrantes. Los regímenes:

- Slots firmados: intactos, verificados por hash (firma 2).
- Trigger payload: mínimo, autenticado por transporte, truncado.
- Retriever sobre `context/`: angostado según esta sección.
- Lecturas del mundo: tipadas por esquema (§11.4).

El slot dinámico rompe la verificabilidad dos veces: en la **selección** (qué entra, decidida en T2, no firmada) y en la **compactación** (`summarize` reescribe; el texto que el modelo lee no es el que existía). La segunda es la más peligrosa: una inyección que pasa por un resumidor sale lavada, reescrita con la voz del resumidor, despojada de las marcas de origen que permitirían sospechar de ella. El resumen es un lavadero de procedencia. El problema de fondo no es un bug: los LLM no tienen separación de plano de control y plano de datos; en la ventana todo es texto y el texto persuasivo es ejecutable. La estrategia no es eliminar la selección y la compresión sino angostarlas hasta que lo no verificable sea mínimo, con un firewall después.

### 10.1 Capa 1: cerrar y firmar el corpus

`context/` no es un knowledge base abierto: es un snapshot escrito en T0, cerrado y conocido al momento de la atestación. La atestación DEBE incluir el manifiesto del corpus (lista de archivos con SHA-256). El retriever DEBE verificar el hash de cada archivo antes de considerarlo: un archivo agregado o modificado post-firma no existe para el assemble. La superficie se reduce de "cualquier contenido inyectado entre T0 y T2" a "contenido ya envenenado en T0", que es un problema de procedencia (§14.1), no de integridad. Regla general: la no-determinación tolerable es la de la selección y la compresión; la del contenido no se tolera nunca, porque firmar un corpus cerrado es barato.

### 10.2 Capa 2: determinizar la selección

La recuperación primaria DEBE ser recorrido de grafo desde documentos firmados: `instructions.md` linkea explícitamente (cross-links OKF) los conceptos de contexto que el sucesor necesita. La selección hereda la firma por transitividad y es determinista, auditable y reproducible.

La búsqueda por similitud queda relegada al único caso que la justifica: contexto cuya relevancia depende del payload del trigger, desconocido en T0. Ese residuo DEBE acotarse con sub-presupuesto propio dentro del slot y DEBE registrarse: el assemble asienta qué seleccionó y por qué vía, para que la selección no firmada sea auditable ex post.

### 10.3 Capa 3: gobernar la compactación

1. **Extractivo antes que abstractivo**: el resumen extractivo (oraciones literales del original) no puede inventar contenido ni reformular una instrucción inyectada con voz propia; a lo sumo la copia, y la copia conserva sus marcas. Extractivo por defecto; abstractivo solo para material de riesgo bajo.
2. **Procedencia obligatoria por afirmación**: cada fragmento del resumen carga el concept ID de origen. El guardrail `reference_check` pasa de heurística a verificable: toda afirmación es rastreable a un archivo con hash firmado. Afirmación sin origen rastreable NO DEBE entrar a la ventana.
3. **El compactador es un agente con contrato propio y trivial**: sin tools, sin efectos, un slot de entrada, salida acotada, instrucciones firmadas que le ordenan tratar todo material como datos. Un modelo sin herramientas manipulado solo puede producir un mal resumen, y el mal resumen lo ataja la verificación de procedencia. La inyección debe sobrevivir dos modelos con contratos distintos en cascada; cada capa multiplica el costo del ataque.

### 10.4 Capa 4: el firewall

Aunque todo lo anterior falle y una instrucción hostil llegue nítida a la ventana, el manifiesto de efectos acota el daño: la lista es cerrada, firmada y aplicada fuera del modelo. El atacante que controla completamente el slot de contexto puede, como máximo, hacer mal uso de los efectos enumerados dentro de sus constraints, o causar un abort. De "ejecución arbitraria" a "mal uso acotado de operaciones enumeradas".

---

## 11. El shim de efectos

El shim es un **monitor de referencia** en el sentido clásico, y DEBE satisfacer sus tres propiedades: mediación completa (ningún efecto llega al mundo sin pasar por él), inviolabilidad (el sujeto mediado no puede modificarlo) e verificabilidad (chico y determinista, auditable).

### 11.1 Posición: proxy MCP

El shim es un servidor MCP proxy. El agente despertado se conecta a un único servidor que expone exactamente los efectos del manifiesto como tools, con los nombres del manifiesto, y nada más; el host NO DEBE montarle otro servidor. Esto compra:

1. **Mediación completa por construcción**: la tool list del agente es el manifiesto y punto.
2. **Aislamiento de credenciales**: las claves reales viven en el shim; el modelo jamás las ve. Ni la inyección más exitosa puede exfiltrarlas ni usarlas fuera del canal mediado.
3. **Distancia cero entre lo autorizado y lo posible**: el conjunto de tools visible es literalmente el contrato firmado. En términos de capacidades: el manifiesto define capacidades, el shim las materializa, el agente opera en un mundo donde solo existen sus capacidades. No hay ambient authority.

### 11.2 Secuencia de mediación

Cada tool call atraviesa una tubería fija (barato antes que caro, determinista antes que externo):

1. **Resolución**: el nombre mapea a un effect_id. Si no mapea: rechazo seco con registro. Un tool inexistente invocado es señal de steering y cuenta para el umbral de escalada.
2. **Ledger**: si el efecto está `confirmed`, el shim NO re-ejecuta y NO devuelve error: devuelve el resultado registrado de la ejecución original, como si acabara de ocurrir. El agente reintentado necesita continuar su plan con los resultados de efectos previos; un error lo desviaría, el resultado cacheado lo deja retomar donde el predecesor murió. La idempotencia bien hecha es transparente para el que reintenta. Si `attempts` alcanzó `max_invocations`: rechazo y escalada.
3. **Constraints** contra `facts.md` firmado y el ledger, con el lenguaje de §12. Nunca contra el slot dinámico.
4. **Asiento `attempted`** en el ledger, con clave, parámetros y fencing token, antes de tocar el mundo.
5. **Ejecución real** con la clave de idempotencia derivada.
6. **Asiento `confirmed`** con hash del resultado.
7. **Retorno al agente.**

Los asientos 4 y 6 se escriben con el fencing token del orquestador que instanció al agente. Consecuencia automática: si el lease venció mientras el agente pensaba, su próximo tool call muere en el paso 4, porque el store rechaza el token viejo. El fencing token se propaga hasta la granularidad de efecto y contiene al agente zombie justo antes de tocar el mundo, sin mecanismo adicional.

### 11.3 El hueco attempted-sin-confirmed

Crash entre los pasos 4 y 6: el ledger dice `attempted`, el mundo quizás cambió. Es el teorema de §7.1 en escala mínima. Jerarquía de respuestas:

1. Sistema externo consultable: el sucesor reconcilia con un efecto de lectura antes de decidir.
2. No consultable pero acepta claves de idempotencia: reintento a ciegas con la misma clave; el receptor deduplica.
3. Ninguna de las dos: estado ambiguo, escalada obligatoria, porque resolver la ambigüedad requiere información que el sistema no tiene.

Corolario de diseño: al escribir el manifiesto, DEBERÍAN preferirse APIs consultables o idempotentes para los efectos irreversibles.

### 11.4 Efectos de lectura

Leer el estado actual del mundo es un efecto enumerado (`kind: read`): la frescura no se recupera gratis, se compra declarándola. Las lecturas tienen el riesgo invertido: no cambian el mundo, pero su resultado entra a la ventana como dato externo vivo sin firma de T0: una nueva boca del canal de datos.

Mitigación: el manifiesto declara el esquema de la respuesta y el shim DEBE validar la respuesta real contra ese esquema antes de devolverla, descartando todo campo no declarado. Las lecturas devuelven datos tipados y estructurados, nunca prosa libre: un `{status, amount, currency}` y no "un resumen de la situación". La prosa libre externa es el vehículo natural de la inyección; un entero validado contra esquema es un vehículo pésimo.

### 11.5 Constraints que requieren juicio

Tres respuestas, en orden de preferencia:

1. **Endurecer hasta que sea determinista**: en T0, cuando el creador sabe qué aceptó el cliente, la constraint se compila a valor (`amount == 4200`, no "lo que corresponda"). La mayoría de las constraints de juicio son juicio diferido por pereza de T0; el diseño correcto empuja el juicio al momento en que había un humano y lo congela en la firma. Este es el default.
2. **Escalar**: si el juicio depende genuinamente de información de T2, el efecto requiere aprobación humana vía `escalated`. Honesto y caro.
3. **Juez con asimetría de información deliberada**: un segundo modelo evalúa la invocación viendo solo la invocación, las constraints y los hechos firmados, y deliberadamente NO viendo el slot dinámico ni el razonamiento del agente. La inyección que torció al agente viajó por el contexto blando; el juez no lo lee, así que el vector no lo alcanza. Torcer a ambos exige dos vectores independientes en dos superficies con regímenes distintos. No es garantía: es economía del ataque, y se declara como tal. El veredicto del juez es capa probabilística sobre el piso determinista del motor de constraints, nunca reemplazo. Su contrato CCDD es trivial: sin tools, entrada mínima, salida binaria con justificación.

---

## 12. El lenguaje de constraints

### 12.1 Requisitos derivados

Total (toda evaluación termina con veredicto), determinista, evaluable solo contra material firmado más ledger, serializable dentro del manifiesto firmado, auditable. Esto es una clase de problema resuelta: la familia de policy languages no-Turing-completos (CEL, Rego, Cedar). La decisión correcta es NO inventar un lenguaje y concentrar el diseño en la semántica de evaluación.

### 12.2 Entorno cerrado por tipo

El entorno de evaluación se construye con exactamente tres objetos: los parámetros de la invocación, el snapshot de `facts.md`, el snapshot del ledger. Una constraint que referencia algo fuera de eso no evalúa a falso: **no compila**, y el error se detecta en T0, en el lint, cuando hay un humano para corregirlo. La diferencia entre prohibir y hacer inexpresable; en seguridad, la segunda gana.

### 12.3 Falla cerrada con tres salidas

- **permit**: todo evaluó verdadero.
- **deny**: algo evaluó falso limpiamente. La invocación viola el contrato; se rechaza y el agente puede replanificar. Es el sistema funcionando.
- **error de evaluación**: hecho ausente, tipo incompatible. El contrato no describe la realidad; no es culpa de la invocación sino del ticket. No se rechaza y se sigue: **se escala**. Es el sistema descubriendo que su contrato está mal formado, la condición definida como "excede la autoridad del agente".

NO DEBE usarse lógica trivalente con propagación de unknown: un veredicto ambiguo en la última línea de defensa es veneno.

### 12.4 El reloj como dato

Las constraints temporales NO DEBEN leer el reloj del sistema: el evaluador recibe `now` como input explícito que queda asentado en el registro de auditoría (mismo principio que el `--now` obligatorio de `check_freshness.py`). El veredicto es determinista relativo a sus inputs registrados: la única clase de determinismo que existe cuando el tiempo importa.

### 12.5 Composición conjuntiva pura

Todas las constraints de un efecto deben pasar; deny de cualquiera es deny del conjunto. Sin prioridades, sin overrides, sin excepciones. Cada constraint es una afirmación independiente verificable en aislamiento, y agregar una constraint solo puede restringir, jamás ampliar. Esa monotonía permite que el revisor de T0 (o el quórum) apruebe constraints de a una sin razonar sobre interacciones.

### 12.6 Techo de expresividad

Lo cross-efecto entra vía ledger: ordenamiento (`ledger.charge.state == "confirmed"`) y presupuestos acumulados (`sum(ledger.*.amount) + params.amount <= facts.budget_total`) como predicados sobre él. Cuantificadores acotados sobre colecciones declaradas, agregaciones simples; nada de recursión ni bucles. Todo lo que no entra en el techo no es una constraint que falta expresar: es juicio, y pertenece a §13.

### 12.7 Auditoría por reproducción

Cada evaluación DEBE asentar la tupla completa de inputs (hash del snapshot de facts, parámetros, now, hash del snapshot del ledger) junto al veredicto. Cualquiera puede re-ejecutar la evaluación con esos inputs y obtener el mismo veredicto: las disputas dejan de ser forenses y pasan a ser reproducciones. El mismo movimiento que la atestación firmada: el juicio ligado a evidencia re-verificable.

---

## 13. Escalada

La escalada es la reintroducción controlada del juicio humano en un sistema cuyo propósito era prescindir de él. Su diseño es económico: cada escalada gasta el recurso que el sistema ahorra; cada no-escalada arriesga daño sin supervisión.

### 13.1 Disparadores en dos clases

**Duros** (deterministas, computados en shim y orquestador, fuera del alcance de la persuasión): error de evaluación de constraints (§12.3), efecto ambiguo sin vía de reconciliación (§11.3), veto del juez, agotamiento próximo de reintentos, contadores de anomalía (invocaciones fuera del manifiesto, denies repetidos del mismo efecto: un agente que insiste contra el monitor está, con alta probabilidad, siendo dirigido).

**Blandos** (probabilísticos, pasan por el modelo): el agente declara que no puede fundamentar una decisión; el juez aprueba con confianza baja.

Las clases NO DEBEN mezclarse, por razón adversarial: una inyección puede intentar suprimir la escalada, pero la supresión solo alcanza a los disparadores blandos. Los disparadores que protegen contra el peor caso DEBEN ser todos duros; los blandos agregan sensibilidad, nunca cargan la responsabilidad. Dual: la inyección que fuerza escaladas masivas logra solo una denegación de servicio hacia un humano, el modo de falla seguro por definición. Atacar la escalada en cualquier dirección es o inútil o inofensivo.

### 13.2 Calibración por ticket, firmada

NO DEBE haber umbral global. El costo del falso negativo está acotado por el manifiesto de efectos de cada ticket: exactamente el radio de daño del peor caso. El umbral es función de ese radio: efectos baratos y reversibles toleran umbral alto; efectos irreversibles o caros merecen umbral bajo. La reversibilidad del efecto, no su probabilidad de salir mal, fija cuánta autonomía se delega.

La política de escalada por efecto (qué disparadores aplican, con qué sensibilidad) es un campo del manifiesto, cubierto por la misma atestación. La firma del creador significa "autorizo estos efectos con este nivel de supervisión": autonomía y vigilancia se contratan juntas, en el mismo acto criptográfico.

### 13.3 El después

El paquete de escalada se arma con piezas existentes: ticket, invocación disputada, trail de veredictos con inputs re-ejecutables, estado del ledger. La decisión humana reentra por la única puerta definida: re-atestación o cancelación firmada.

Interacción con la vigencia, sin atajo: el ticket escalado sigue envejeciendo, porque `valid_until` está firmado y pausar el reloj sería extender la ventana sin re-firmar, exactamente lo que la atestación impide. Si el humano tarda más que la ventana, el ticket expira esperando y la respuesta tardía se materializa como ticket nuevo con `supersedes`. No es un defecto: una ventana firmada que se estira "porque hay un humano pensando" es una ventana que no acota nada. La expiración durante escalada es el precio de que `valid_until` signifique algo, y el linaje paga ese precio sin pérdida de información.

---

## 14. Residuos irreducibles

Lo que ninguna firma cubre, nombrado con honestidad:

### 14.1 Envenenamiento en T0

Si el material de `context/` ya venía hostil (un mail con inyección, un documento externo manipulado), la firma lo sella fielmente: garantiza integridad de algo que nació podrido. La firma autentica origen, no verdad ni benignidad. Defensa de procedencia: `ccdd_provenance` en cada concepto de `context/` registra el origen, y el gradiente de severidad aplica también acá: material de origen externo no confiable se marca y el compactador lo trata con el régimen más estricto (extractivo, delimitado, o excluido de los slots de los efectos de mayor riesgo).

### 14.2 Steering semántico

Un contexto sutilmente sesgado (un énfasis, no una inyección) que empuja al agente a elegir el máximo permitido en vez del valor correcto pasa todas las verificaciones sintácticas: no viola, persuade. No hay firma posible contra esto; hay constraints más ajustadas (a precio de rigidez) y hay escalada calibrada para que la ambigüedad económicamente relevante suba a humano.

### 14.3 La tensión con la frescura

El corpus firmado es un snapshot de T0 y el mundo se movió para T2. Dejar que el retriever busque datos vivos reabriría todo lo cerrado. Resolución coherente: los datos vivos entran solo por canales con régimen propio: el trigger payload (mínimo, autenticado) o efectos de lectura declarados y tipados (§11.4).

### 14.4 Ambigüedad no reconciliable

El efecto `attempted` contra un sistema no consultable y no idempotente (§11.3, opción 3). Escalada obligatoria: la información para resolver no existe dentro del sistema.

---

## 15. Conformidad

Una implementación es conformante con TED 0.1 si:

1. El bundle de cada ticket es conformante con OKF v0.1 (frontmatter parseable, `type` no vacío) y su contrato valida contra el schema CCDD correspondiente. Cuando el agente ejecutor no consume una ventana de contexto real (por ejemplo, una implementación de referencia con un agente determinista sin modelo detrás), este punto se satisface sobre los datos que el contrato de rehidratación gobernaría — slots firmados, contexto — sin exigir un ensamblador de prompt como artefacto separado: no tiene sentido validar un componente sin consumidor real.
2. Existe la partición de §3: estado disputado en un store con CAS y TTL; lo firmado y auditable en el bundle. Ninguna decisión de ejecución se toma leyendo campos `projected_`.
3. Toda transición de la máquina de §6 exige la credencial de su actor, y los cuatro terminales son irreversibles en el store.
4. La cadena de verificación de `pending → leased` se ejecuta completa y en orden antes de instanciar el agente, incluyendo consulta al CRL.
5. Todo efecto del agente pasa por un shim que satisface las tres propiedades del monitor de referencia, con las claves reales inaccesibles para el modelo.
6. El ledger de efectos implementa la sub-máquina `declared → attempted → confirmed` con asientos portadores de fencing token.
7. Las constraints se evalúan en un entorno cerrado a parámetros, hechos firmados y ledger, con semántica permit / deny / error y `now` como input registrado.
8. Toda respuesta de efecto de lectura se valida contra su esquema declarado antes de entrar a la ventana.
9. Los disparadores duros de escalada se computan fuera del modelo.
10. La atestación cubre la tupla completa de hashes (instrucciones, efectos, hechos, manifiesto de corpus) más la ventana, y existe mecanismo de revocación firmada.

Los consumidores DEBERÍAN tratar el resto de este documento como guía fuerte. En particular, la selección por grafo (§10.2), la compactación extractiva (§10.3) y el juez (§11.5) son RECOMENDADOS pero no obligatorios para conformidad mínima.

---

## 16. Relación con otros specs

- **MCP**: TED no lo extiende ni lo modifica. MCP queda como interfaz sincrónica modelo-herramientas dentro de una sesión; el shim se implementa como servidor MCP estándar; el orquestador instancia hosts MCP nuevos por ejecución.
- **OKF v0.1**: los tickets son bundles conformantes. Las claves de extensión (`ccdd_*`, `ticket_id`, `trigger`, `attestation`, `projected_*`) viajan en frontmatter al amparo de la cláusula de recepción permisiva de OKF §9.
- **CCDD 0.3**: el contrato de rehidratación, la firma de slots, el quórum de revisión y los guardrails se usan tal cual. TED agrega semántica de uso (política `abort` para agentes sin supervisión, contratos triviales para compactador y juez), no primitivas nuevas.
- La capa de vigencia (atestación con ventana, revocación, expiración) extiende el patrón de la POC okf-integration: la atestación se mueve de "sigue siendo verdad" a posteriori hacia "es válido hasta X" en origen, con caducidad criptográfica.

---

## 17. Versionado

Este documento especifica TED versión 0.1. Revisiones futuras se versionan `<mayor>.<menor>`: menor para adiciones retrocompatibles (nuevos campos opcionales del manifiesto, nuevos disparadores), mayor para cambios que rompen (semántica de la máquina de estados, estructura de la atestación).

### 17.1 Historial de revisiones

- **0.1.1**: corrección de §6.3. La cadena de verificación de `pending → leased` ya describía que
  el paso 3 (hash, CRL, vigencia) puede fallar de tres formas, pero el texto solo nombraba
  explícitamente el destino del fallo de hash (`failed`); no aclaraba que las tres fallas ocurren
  **desde `leased`** (el CAS del paso 2 ya movió el ticket ahí) ni nombraba destino para un hit
  de CRL. Se agregan las aristas `leased → expired` y `leased → cancelled` (el conteo pasa de
  nueve a once transiciones), con la tabla completa en §6.3, y se precisa §15 punto 1 sobre qué
  significa "contrato de rehidratación validable" cuando el agente ejecutor no tiene ventana de
  contexto real que gobernar. Cambio menor (§17): no rompe semántica existente, la explicita.
  Encontrado al construir una implementación de referencia completa contra este documento.
- **0.1**: versión inicial.

---

## Apéndice A: síntesis del ciclo completo

En T0, el agente creador escribe `instructions.md`, `effects.md`, `facts.md` y `context/`; el creador atesta firmando todos los hashes más el manifiesto de corpus, con ventana de validez; el CAS crea el registro `pending` en el store.

En T2 llega el callback: firma de transporte y ventana temporal; CAS a `leased` con fencing token; hashes contra la atestación; CRL; vigencia. El assemble construye la ventana con los slots firmados intactos, el payload truncado y el contexto angostado. El agente ejecuta contra el shim, que valida cada efecto contra el manifiesto y las constraints sobre hechos firmados, asienta el ledger con el token, y tipa las lecturas.

Al terminar, el orquestador escribe `result.md`, actualiza la proyección, agrega las entradas de log y cierra el estado con su token. Todo lo firmado nunca cambió; todo lo que cambió nunca estuvo firmado; y la infraestructura no-OKF es un store chico con CAS y TTL, un shim, y dos modelos auxiliares opcionales con contratos triviales.

## Apéndice B: propiedades de seguridad, en una mirada

1. Tres firmas ortogonales (transporte, contenido, atestación) con vidas y roles distintos; comprometer una no completa un flujo malicioso.
2. Cuatro clases de actor con cuatro credenciales; la raíz de confianza es la clave del creador.
3. Fencing tokens propagados hasta la granularidad de efecto: los agentes zombie se contienen justo antes de tocar el mundo.
4. Mediación completa vía proxy MCP con aislamiento de credenciales y capacidades puras.
5. Todo canal de entrada a la ventana tiene régimen declarado; todo efecto de salida pasa por el monitor.
6. El peor caso bajo compromiso total del canal de datos es mal uso acotado de efectos enumerados, o denegación de servicio hacia un humano.
