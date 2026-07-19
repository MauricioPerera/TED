// Evaluador de constraints (permit/deny/error).
// Contrato: knowledge/contracts/ted-constraints.md. Gramatica minima, determinista,
// entorno cerrado por tipo. `now` es input explicito (nunca el reloj). Sin librerias
// CEL/Rego/Cedar reales: tokenizer + parser recursivo simple alcanza (S12).
import { createHash } from "node:crypto";
import type {
  ConstraintEvalResult,
  ConstraintLedgerSnapshot,
  ConstraintVerdict,
} from "../types.ts";

export class ConstraintCompileError extends Error {}

export interface CompiledConstraint {
  source: string;
  // AST interno cacheado por compileConstraint. Opcional para no romper la
  // interfaz publica del contrato; siempre lo setea compileConstraint.
  ast?: ConstraintAst;
}

// --- AST ----------------------------------------------------------------------

type Root = "params" | "facts" | "ledger";
type Comparator = "==" | "!=" | "<" | "<=" | ">" | ">=";

type TermNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "now" }
  | { kind: "path"; root: Root; segments: string[] }
  | { kind: "sum"; path: { root: Root; segments: string[] } };

type ExprNode =
  | { kind: "term"; term: TermNode }
  | { kind: "add"; left: ExprNode; right: ExprNode };

type ConstraintAst = {
  kind: "comparison";
  left: ExprNode;
  op: Comparator;
  right: ExprNode;
};

// --- Tokenizer ----------------------------------------------------------------

type Tok = { type: string; value: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && src.charAt(j) !== '"') {
        if (src.charAt(j) === "\\") {
          const next = src.charAt(j + 1);
          if (next === '"' || next === "\\") {
            s += next;
            j += 2;
            continue;
          }
          throw new ConstraintCompileError("invalid escape in string literal");
        }
        s += src.charAt(j);
        j++;
      }
      if (j >= n) throw new ConstraintCompileError("unterminated string literal");
      toks.push({ type: "string", value: s });
      i = j + 1;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && ((src.charAt(j) >= "0" && src.charAt(j) <= "9") || src.charAt(j) === ".")) {
        j++;
      }
      const num = src.slice(i, j);
      if (!/^[0-9]+(\.[0-9]+)?$/.test(num)) {
        throw new ConstraintCompileError(`invalid number: ${num}`);
      }
      toks.push({ type: "number", value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src.charAt(j))) j++;
      toks.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      toks.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">") {
      toks.push({ type: "op", value: c });
      i++;
      continue;
    }
    if (c === "+") {
      toks.push({ type: "plus", value: c });
      i++;
      continue;
    }
    if (c === "*") {
      toks.push({ type: "star", value: c });
      i++;
      continue;
    }
    if (c === ".") {
      toks.push({ type: "dot", value: c });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ type: "lparen", value: c });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ type: "rparen", value: c });
      i++;
      continue;
    }
    throw new ConstraintCompileError(`unexpected character: ${c}`);
  }
  toks.push({ type: "eof", value: "" });
  return toks;
}

// --- Parser ------------------------------------------------------------------

function parse(src: string): ConstraintAst {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok => toks[pos] as Tok;
  const eat = (type: string): Tok => {
    const t = toks[pos] as Tok;
    if (t.type !== type) {
      throw new ConstraintCompileError(`expected ${type}, got ${t.type}`);
    }
    pos++;
    return t;
  };

  function parseExpr(): ExprNode {
    let left: ExprNode = { kind: "term", term: parseTerm() };
    while (peek().type === "plus") {
      eat("plus");
      const right: ExprNode = { kind: "term", term: parseTerm() };
      left = { kind: "add", left, right };
    }
    return left;
  }

  function parseTerm(): TermNode {
    const t = peek();
    if (t.type === "number") {
      pos++;
      return { kind: "number", value: Number.parseFloat(t.value) };
    }
    if (t.type === "string") {
      pos++;
      return { kind: "string", value: t.value };
    }
    if (t.type === "ident") {
      if (t.value === "true") {
        pos++;
        return { kind: "bool", value: true };
      }
      if (t.value === "false") {
        pos++;
        return { kind: "bool", value: false };
      }
      if (t.value === "now") {
        pos++;
        return { kind: "now" };
      }
      if (t.value === "sum") {
        pos++;
        eat("lparen");
        const path = parsePath();
        eat("rparen");
        return { kind: "sum", path };
      }
      if (t.value === "params" || t.value === "facts" || t.value === "ledger") {
        return { kind: "path", ...parsePath() };
      }
      // Identificador que no es raiz valido ni keyword -> no compila (S12.2).
      throw new ConstraintCompileError(`unknown root or term: ${t.value}`);
    }
    throw new ConstraintCompileError(`unexpected token: ${t.type}`);
  }

  function parsePath(): { root: Root; segments: string[] } {
    const rootTok = eat("ident");
    if (rootTok.value !== "params" && rootTok.value !== "facts" && rootTok.value !== "ledger") {
      throw new ConstraintCompileError(`invalid path root: ${rootTok.value}`);
    }
    const root = rootTok.value as Root;
    const segments: string[] = [];
    while (peek().type === "dot") {
      eat("dot");
      const seg = peek();
      if (seg.type === "ident") {
        pos++;
        segments.push(seg.value);
      } else if (seg.type === "star") {
        pos++;
        segments.push("*");
      } else {
        throw new ConstraintCompileError(`invalid path segment: ${seg.type}`);
      }
    }
    return { root, segments };
  }

  const left = parseExpr();
  const opTok = peek();
  if (opTok.type !== "op") {
    throw new ConstraintCompileError(`expected comparator, got ${opTok.type}`);
  }
  pos++;
  const op = opTok.value as Comparator;
  const right = parseExpr();
  if (peek().type !== "eof") {
    throw new ConstraintCompileError("trailing tokens after constraint");
  }
  return { kind: "comparison", left, op, right };
}

// --- Evaluacion ---------------------------------------------------------------

type Env = {
  params: Record<string, unknown>;
  facts: Record<string, unknown>;
  ledger: ConstraintLedgerSnapshot;
};

type Scalar = number | string | boolean;
type EvalOutcome = { ok: true; value: Scalar } | { ok: false; reason: string };

function okValue(value: Scalar): EvalOutcome {
  return { ok: true, value };
}
function errValue(reason: string): EvalOutcome {
  return { ok: false, reason };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function rootObject(root: Root, env: Env): Record<string, unknown> {
  return root === "params" ? env.params : root === "facts" ? env.facts : env.ledger;
}

function resolvePath(root: Root, segments: string[], env: Env): EvalOutcome {
  let cur: unknown = rootObject(root, env);
  for (const seg of segments) {
    if (seg === "*") return errValue("wildcard outside sum()");
    if (cur === null || typeof cur !== "object") return errValue(`cannot index into ${seg}`);
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
      return errValue(`absent key: ${seg}`);
    }
    cur = obj[seg];
  }
  if (typeof cur === "number" || typeof cur === "string" || typeof cur === "boolean") {
    return okValue(cur);
  }
  return errValue("path does not resolve to a scalar");
}

function evalSum(path: { root: Root; segments: string[] }, env: Env): EvalOutcome {
  const starIdx = path.segments.indexOf("*");
  if (starIdx === -1) return errValue("sum() requires a wildcard segment");
  let base: unknown = rootObject(path.root, env);
  for (let i = 0; i < starIdx; i++) {
    const seg = path.segments[i] as string;
    if (base === null || typeof base !== "object") return errValue("absent key in sum() path");
    const obj = base as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
      return errValue(`absent key: ${seg}`);
    }
    base = obj[seg];
  }
  if (base === null || typeof base !== "object") return errValue("sum() root is not an object");
  const iterBase = base as Record<string, unknown>;
  const rest = path.segments.slice(starIdx + 1);
  let total = 0;
  for (const key of Object.keys(iterBase)) {
    let v: unknown = iterBase[key];
    for (const seg of rest) {
      if (v === null || typeof v !== "object") return errValue("absent key in sum() entry");
      const obj = v as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
        return errValue(`absent key: ${seg}`);
      }
      v = obj[seg];
    }
    if (typeof v !== "number" || Number.isNaN(v)) {
      return errValue("sum() entry is not a number");
    }
    total += v;
  }
  return okValue(total);
}

function evalTerm(node: TermNode, env: Env, now: string): EvalOutcome {
  switch (node.kind) {
    case "number":
      return okValue(node.value);
    case "string":
      return okValue(node.value);
    case "bool":
      return okValue(node.value);
    case "now":
      return okValue(now);
    case "path":
      return resolvePath(node.root, node.segments, env);
    case "sum":
      return evalSum(node.path, env);
    default:
      return errValue("unknown term");
  }
}

function evalExpr(node: ExprNode, env: Env, now: string): EvalOutcome {
  if (node.kind === "term") return evalTerm(node.term, env, now);
  const l = evalExpr(node.left, env, now);
  if (!l.ok) return l;
  const r = evalExpr(node.right, env, now);
  if (!r.ok) return r;
  if (typeof l.value !== "number" || typeof r.value !== "number") {
    return errValue("non-numeric addition");
  }
  return okValue(l.value + r.value);
}

function evalEquality(
  op: Comparator,
  l: Scalar,
  r: Scalar,
): { verdict: ConstraintVerdict; reason: string } {
  if (typeof l !== typeof r) {
    return { verdict: "error", reason: "type mismatch across ==" };
  }
  const eq = l === r;
  const permit = op === "==" ? eq : !eq;
  return { verdict: permit ? "permit" : "deny", reason: permit ? "equal" : "not equal" };
}

function evalNumericOrdering(
  op: Comparator,
  l: number,
  r: number,
): { verdict: ConstraintVerdict; reason: string } {
  const res = compareNum(op, l, r);
  return { verdict: res ? "permit" : "deny", reason: res ? "within" : "out of range" };
}

function evalIsoOrdering(
  op: Comparator,
  l: string,
  r: string,
): { verdict: ConstraintVerdict; reason: string } {
  if (!ISO_RE.test(l) || !ISO_RE.test(r)) {
    return { verdict: "error", reason: "non-ISO string in ordering" };
  }
  const a = Date.parse(l);
  const b = Date.parse(r);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return { verdict: "error", reason: "unparseable date" };
  }
  const res = compareNum(op, a, b);
  return { verdict: res ? "permit" : "deny", reason: res ? "within" : "out of range" };
}

function evalOrdering(
  op: Comparator,
  l: Scalar,
  r: Scalar,
): { verdict: ConstraintVerdict; reason: string } {
  if (typeof l === "number" && typeof r === "number") {
    return evalNumericOrdering(op, l, r);
  }
  if (typeof l === "string" && typeof r === "string") {
    return evalIsoOrdering(op, l, r);
  }
  return { verdict: "error", reason: "incomparable types for ordering" };
}

function evalConstraintAst(
  ast: ConstraintAst,
  env: Env,
  now: string,
): { verdict: ConstraintVerdict; reason: string } {
  const l = evalExpr(ast.left, env, now);
  if (!l.ok) return { verdict: "error", reason: l.reason };
  const r = evalExpr(ast.right, env, now);
  if (!r.ok) return { verdict: "error", reason: r.reason };
  const op = ast.op;

  if (op === "==" || op === "!=") {
    return evalEquality(op, l.value, r.value);
  }
  return evalOrdering(op, l.value, r.value);
}

function compareNum(op: Comparator, a: number, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return false;
  }
}

// --- Auditoria (reproducible, S12.7) ------------------------------------------

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map(stableStringify).join(",") + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

function auditTrail(
  params: Record<string, unknown>,
  facts: Record<string, unknown>,
  ledger: ConstraintLedgerSnapshot,
  now: string,
): ConstraintEvalResult["auditTrail"] {
  return {
    factsSha256: sha256Hex(stableStringify(facts)),
    paramsHash: sha256Hex(stableStringify(params)),
    now,
    ledgerSha256: sha256Hex(stableStringify(ledger)),
  };
}

// --- API publica --------------------------------------------------------------

export function compileConstraint(source: string): CompiledConstraint {
  const ast = parse(source);
  return { source, ast };
}

export function evaluateConstraint(
  compiled: CompiledConstraint,
  params: Record<string, unknown>,
  facts: Record<string, unknown>,
  ledger: ConstraintLedgerSnapshot,
  now: string,
): ConstraintEvalResult {
  const ast = compiled.ast ?? parse(compiled.source);
  const env: Env = { params, facts, ledger };
  const r = evalConstraintAst(ast, env, now);
  const result: ConstraintEvalResult = {
    verdict: r.verdict,
    auditTrail: auditTrail(params, facts, ledger, now),
  };
  result.reason = r.reason;
  return result;
}

export function evaluateAll(
  compiled: CompiledConstraint[],
  params: Record<string, unknown>,
  facts: Record<string, unknown>,
  ledger: ConstraintLedgerSnapshot,
  now: string,
): ConstraintEvalResult {
  const env: Env = { params, facts, ledger };
  let verdict: ConstraintVerdict = "permit";
  let reason = "all permit";
  for (const c of compiled) {
    const ast = c.ast ?? parse(c.source);
    const r = evalConstraintAst(ast, env, now);
    if (r.verdict === "error") {
      verdict = "error";
      reason = r.reason;
      break;
    }
    if (r.verdict === "deny") {
      verdict = "deny";
      reason = r.reason;
    }
  }
  const result: ConstraintEvalResult = {
    verdict,
    auditTrail: auditTrail(params, facts, ledger, now),
  };
  result.reason = reason;
  return result;
}