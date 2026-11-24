/**
 * Unreal Engine Framework Resolver
 *
 * Unreal C++ already parses: the C/C++ extractor blanks the reflection markup
 * (`UCLASS(...)`, `UFUNCTION(...)`, `UPROPERTY(...)`, `GENERATED_BODY()`) to
 * spaces before tree-sitter sees it, so classes, out-of-line method bodies and
 * calls survive. What that blanking throws away is what the markup MEANS, and
 * that is most of how an Unreal project is wired. This resolver reads the
 * original source back and puts it in the graph.
 *
 * ## What it adds
 *
 * 1. **Specifiers on classes and functions** (`postExtract`). A `UCLASS` /
 *    `USTRUCT` / `UENUM` / `UINTERFACE` type and every `UFUNCTION` method get
 *    their markup as `decorators` and in front of their `signature`
 *    (`UFUNCTION(BlueprintCallable, Category="Hit") void ApplyHit(...)`), so a
 *    search for `BlueprintCallable`, `Server` or `Exec` finds them and an
 *    outline shows them. The method a header declares is usually defined in a
 *    `.cpp`; the specifiers land on that definition.
 *
 * 2. **Reflected functions with no body of their own** (`extract`, headers).
 *    A `BlueprintImplementableEvent` has no C++ body at all; a
 *    `BlueprintNativeEvent` and a `Server` / `Client` / `NetMulticast` RPC
 *    have their body in `<Name>_Implementation` (and `<Name>_Validate`), which
 *    the Unreal Header Tool wires up. The C++ extractor indexes no in-class
 *    prototype, so a call to `ServerFire()` resolved to nothing. Each of these
 *    gets a `method` node at its declaration, with a `calls` reference to its
 *    `_Implementation` / `_Validate`, so a flow runs caller → `ServerFire` →
 *    `ServerFire_Implementation`.
 *
 * 3. **`UPROPERTY` members** (`crossFileNodes`). The C++ extractor indexes no
 *    data members, so a reflected property is a `property` node with its
 *    specifiers. Its references:
 *      - `ReplicatedUsing=OnRep_X` → the `OnRep_X` method;
 *      - a dynamic delegate member bound with `AddDynamic(this, &C::Handler)`
 *        (or `AddUniqueDynamic`, `BindDynamic`) in any source file → each
 *        handler, so `OnHit.Broadcast(...)` (resolved onto the property, see 5)
 *        reaches every listener.
 *    These come from several files at once, which is why they are cross-file
 *    nodes. A node's id carries a hash of its references and signature, so a
 *    new binding or an edited specifier replaces the node (and its edges).
 *
 * 4. **Console variables** (`extract`, any C++ file).
 *    `TAutoConsoleVariable<T> CVarX(TEXT("game.Thing"), …)`,
 *    `FAutoConsoleVariableRef` and `FAutoConsoleCommand*` become `constant`
 *    nodes named after the C++ variable, with the console name in the
 *    signature and the help text as docstring. A command's handler
 *    (`CreateStatic(&Fn)`, `CreateUObject(this, &C::Fn)`, a lambda aside) is
 *    referenced.
 *
 * 5. **Calls the parser can't follow** (`resolve`).
 *      - `X.Broadcast(…)` / `X.ExecuteIfBound(…)` / `X.Execute(…)` → the
 *        delegate property `X` (preferring the caller's own class);
 *      - `CVarX.GetValueOnGameThread()` and friends → the console variable.
 *
 * 6. **Modules** (`extract`, `*.Build.cs`). A `module` node per module, with
 *    `imports` references to the modules it depends on
 *    (`PublicDependencyModuleNames` / `PrivateDependencyModuleNames`). Engine
 *    modules are not indexed, so those stay unresolved.
 *
 * 7. **Config** (`extract`, `.ini` files mapped to `properties` in
 *    `codegraph.json`: `"extensions": { ".ini": "properties" }`). A key under a
 *    `[/Script/Module.Class]` section is a `constant` node with a
 *    `references` edge to the `Config` property it sets.
 *
 * ## Detection
 *
 * A `*.Build.cs` or `*.Target.cs` in the index, or a header including a
 * `.generated.h`.
 */

import * as crypto from 'crypto';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import type { Language, Node } from '../../types';
import type {
  CrossFileNodes,
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { makeLineAt } from '../synth-utils';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Replace comments with spaces (newlines kept), leaving string literals as
 * they are. Every offset survives.
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      // Raw strings R"x(...)x" are rare in reflected headers; treat as normal.
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Replace string and char literal contents with spaces (quotes kept). Input has no comments. */
function blankStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          out[i] = ' ';
          i++;
        }
        if (i < n && src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index of the `)` closing the `(` at `open`, over string-blanked text; -1 if none. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `}` closing the `{` at `open`, over string-blanked text; -1 if none. */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a macro's argument list on top-level commas and normalize each
 * specifier: `meta = (ClampMin = "0")` → `meta=(ClampMin="0")`.
 */
export function parseSpecifiers(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += args[++i] ?? '';
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map(normalizeSpecifier).filter((s) => s.length > 0);
}

function normalizeSpecifier(s: string): string {
  // Collapse whitespace outside strings, drop it around `=` / parens / commas.
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (/\s/.test(c)) {
      const prev = out[out.length - 1];
      const next = s.slice(i + 1).match(/\S/)?.[0];
      if (prev === undefined || '=(,'.includes(prev) || (next !== undefined && '=),'.includes(next))) continue;
      if (prev === ' ') continue;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out.trim();
}

/** The value of `Key=Value` among specifiers (case-insensitive key), unquoted. */
export function specifierValue(specs: readonly string[], key: string): string | null {
  const lower = key.toLowerCase();
  for (const s of specs) {
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    if (s.slice(0, eq).toLowerCase() === lower) return s.slice(eq + 1).replace(/^"(.*)"$/, '$1');
  }
  return null;
}

function hasSpecifier(specs: readonly string[], key: string): boolean {
  const lower = key.toLowerCase();
  return specs.some((s) => s.split('=')[0]!.toLowerCase() === lower);
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Reflection scan
// ---------------------------------------------------------------------------

export interface ReflectedType {
  macro: 'UCLASS' | 'USTRUCT' | 'UENUM' | 'UINTERFACE';
  specs: string[];
  /** `class` | `struct` | `enum` | `namespace` */
  keyword: string;
  name: string;
  line: number;
}

export interface ReflectedMember {
  macro: 'UFUNCTION' | 'UPROPERTY';
  specs: string[];
  /** Innermost enclosing class/struct, or null at file scope. */
  owner: string | null;
  name: string;
  /** The declaration after the macro, on one line, without body or initializer. */
  declaration: string;
  /** The declared type of a property; the return type of a function. */
  type: string;
  /** Line of the declared name (1-based). */
  line: number;
  /** A function declared with its body in the class. */
  hasInlineBody: boolean;
}

export interface ReflectionScan {
  types: ReflectedType[];
  members: ReflectedMember[];
}

const MACRO_RE = /(^|\n)[ \t]*(UCLASS|USTRUCT|UENUM|UINTERFACE|UFUNCTION|UPROPERTY)[ \t]*\(/g;
const TYPE_DEF_RE = /\b(class|struct)\s+(?:alignas\s*\([^)]*\)\s*)?(?:[A-Z][A-Z0-9_]*_API\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?\{/g;

/** Skip whitespace and line-leading ALL-CAPS annotation macros (`UE_DEPRECATED(...)`). */
function skipAnnotations(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    const m = /^[A-Z][A-Z0-9_]{2,}\s*\(/.exec(text.slice(i, i + 80));
    if (!m || /^(UFUNCTION|UPROPERTY|UCLASS|USTRUCT|UENUM|UINTERFACE)\b/.test(m[0])) return i;
    const open = text.indexOf('(', i);
    const close = closeParen(text, open);
    if (close < 0) return i;
    i = close + 1;
  }
}

/** Read every reflection macro in a C++ source and what it decorates. */
export function scanReflection(source: string): ReflectionScan {
  const code = blankComments(source);
  const flat = blankStrings(code);
  const lineAt = makeLineAt(source, 1);

  // Class/struct bodies, for each member's owner.
  const scopes: { name: string; start: number; end: number }[] = [];
  TYPE_DEF_RE.lastIndex = 0;
  for (let m = TYPE_DEF_RE.exec(flat); m; m = TYPE_DEF_RE.exec(flat)) {
    const open = m.index + m[0].length - 1;
    const end = closeBrace(flat, open);
    if (end > open) scopes.push({ name: m[2]!, start: open, end });
  }
  const ownerAt = (offset: number): string | null => {
    let best: { name: string; start: number; end: number } | null = null;
    for (const s of scopes) {
      if (s.start < offset && offset < s.end && (!best || s.start > best.start)) best = s;
    }
    return best ? best.name : null;
  };

  const types: ReflectedType[] = [];
  const members: ReflectedMember[] = [];
  MACRO_RE.lastIndex = 0;
  for (let m = MACRO_RE.exec(flat); m; m = MACRO_RE.exec(flat)) {
    const macro = m[2] as ReflectedType['macro'] | ReflectedMember['macro'];
    const open = m.index + m[0].length - 1;
    const close = closeParen(flat, open);
    if (close < 0) continue;
    const specs = parseSpecifiers(code.slice(open + 1, close));
    const after = skipAnnotations(flat, close + 1);

    if (macro === 'UCLASS' || macro === 'USTRUCT' || macro === 'UENUM' || macro === 'UINTERFACE') {
      const rest = flat.slice(after, after + 400);
      const t =
        /^(?:template\s*<[^>]*>\s*)?(class|struct)\s+(?:alignas\s*\([^)]*\)\s*)?(?:[A-Z][A-Z0-9_]*_API\s+)?([A-Za-z_]\w*)/.exec(rest) ??
        /^(enum)\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)/.exec(rest) ??
        /^(namespace)\s+([A-Za-z_]\w*)/.exec(rest);
      if (!t) continue;
      types.push({ macro, specs, keyword: t[1]!, name: t[2]!, line: lineAt(after + rest.indexOf(t[2]!, t[1]!.length)) });
      continue;
    }

    // UFUNCTION / UPROPERTY: the declaration runs to the first top-level `;`
    // or, for an inline function body, `{`.
    let depth = 0;
    let end = -1;
    let inlineBody = false;
    for (let i = after; i < flat.length; i++) {
      const c = flat[i];
      if (c === '(' || c === '<' || c === '[') depth++;
      else if (c === ')' || c === '>' || c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && c === ';') {
        end = i;
        break;
      } else if (depth === 0 && c === '{') {
        // `{` starts a body for a function, a brace initializer for a property.
        end = i;
        inlineBody = macro === 'UFUNCTION';
        break;
      }
    }
    if (end < 0) continue;
    const decl = flat.slice(after, end);

    if (macro === 'UFUNCTION') {
      const paren = decl.indexOf('(');
      if (paren < 0) continue;
      const head = decl.slice(0, paren);
      const nm = /([A-Za-z_]\w*)\s*$/.exec(head);
      if (!nm) continue;
      const nameOffset = after + nm.index;
      const ret = oneLine(
        head
          .slice(0, nm.index)
          .replace(/\b(virtual|static|inline|FORCEINLINE|explicit|constexpr)\b/g, '')
      );
      members.push({
        macro,
        specs,
        owner: ownerAt(nameOffset),
        name: nm[1]!,
        declaration: oneLine(code.slice(after, end)),
        type: ret,
        line: lineAt(nameOffset),
        hasInlineBody: inlineBody,
      });
    } else {
      // Property: drop the initializer (`= …`), bit field (`: 1`) and array extent.
      let core = decl;
      let d = 0;
      for (let i = 0; i < core.length; i++) {
        const c = core[i];
        if (c === '<' || c === '(' || c === '[') d++;
        else if (c === '>' || c === ')' || c === ']') d = Math.max(0, d - 1);
        else if (d === 0 && (c === '=' || (c === ':' && core[i + 1] !== ':' && core[i - 1] !== ':'))) {
          core = core.slice(0, i);
          break;
        }
      }
      core = core.replace(/\[[^\]]*\]\s*$/, '');
      const nm = /([A-Za-z_]\w*)\s*$/.exec(core);
      if (!nm) continue;
      const nameOffset = after + nm.index;
      members.push({
        macro,
        specs,
        owner: ownerAt(nameOffset),
        name: nm[1]!,
        declaration: oneLine(code.slice(after, after + core.length)),
        type: oneLine(core.slice(0, nm.index)),
        line: lineAt(nameOffset),
        hasInlineBody: false,
      });
    }
  }
  return { types, members };
}

// ---------------------------------------------------------------------------
// Specifier groups
// ---------------------------------------------------------------------------

const RPC_SPECIFIERS = ['Server', 'Client', 'NetMulticast'];

/** A UFUNCTION whose body the Unreal Header Tool routes to `<Name>_Implementation`. */
function hasImplementationBody(specs: readonly string[]): boolean {
  return hasSpecifier(specs, 'BlueprintNativeEvent') || RPC_SPECIFIERS.some((s) => hasSpecifier(specs, s));
}

/** A UFUNCTION with no C++ body anywhere. */
function isBodilessEvent(specs: readonly string[]): boolean {
  return hasSpecifier(specs, 'BlueprintImplementableEvent');
}

const macroSignature = (macro: string, specs: readonly string[]): string => `${macro}(${specs.join(', ')})`;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const HEADER_RE = /\.(h|hh|hpp|hxx|inl)$/i;
const CPP_RE = /\.(h|hh|hpp|hxx|inl|c|cc|cpp|cxx)$/i;
const BUILD_CS_RE = /\.Build\.cs$/;
const INI_RE = /\.ini$/i;

/** Quick textual gate: does this C++ file carry reflection markup? */
const hasReflection = (src: string): boolean => /\b(UCLASS|USTRUCT|UFUNCTION|UPROPERTY|UENUM|UINTERFACE)\s*\(/.test(src);

function cppLanguage(filePath: string): Language {
  return /\.c$/i.test(filePath) ? 'c' : 'cpp';
}

function makeNode(
  filePath: string,
  kind: Node['kind'],
  name: string,
  qualifiedName: string,
  line: number,
  language: Language,
  extra: Partial<Node> = {},
  id?: string
): Node {
  return {
    id: id ?? generateNodeId(filePath, kind, qualifiedName, line),
    kind,
    name,
    qualifiedName,
    filePath,
    language,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...extra,
  };
}

function ref(
  fromNodeId: string,
  referenceName: string,
  referenceKind: UnresolvedRef['referenceKind'],
  line: number,
  filePath: string,
  language: Language
): UnresolvedRef {
  return { fromNodeId, referenceName, referenceKind, line, column: 0, filePath, language };
}

// ---------------------------------------------------------------------------
// extract(): headers — reflected functions with no body of their own
// ---------------------------------------------------------------------------

function extractHeaderEvents(filePath: string, source: string, out: FrameworkExtractionResult): void {
  if (!HEADER_RE.test(filePath) || !hasReflection(source)) return;
  const language = cppLanguage(filePath);
  for (const m of scanReflection(source).members) {
    if (m.macro !== 'UFUNCTION' || !m.owner || m.hasInlineBody) continue;
    const bodiless = isBodilessEvent(m.specs);
    const routed = hasImplementationBody(m.specs);
    if (!bodiless && !routed) continue;
    const qualifiedName = `${m.owner}::${m.name}`;
    const node = makeNode(filePath, 'method', m.name, qualifiedName, m.line, language, {
      signature: `${macroSignature('UFUNCTION', m.specs)} ${m.declaration}`,
      decorators: ['UFUNCTION', ...m.specs],
      visibility: 'public',
      docstring: bodiless
        ? 'Blueprint event: implemented in Blueprint, no C++ body.'
        : `Reflected function: its C++ body is ${m.name}_Implementation.`,
    });
    out.nodes.push(node);
    if (routed) {
      out.references.push(ref(node.id, `${m.owner}::${m.name}_Implementation`, 'calls', m.line, filePath, language));
      if (hasSpecifier(m.specs, 'WithValidation')) {
        out.references.push(ref(node.id, `${m.owner}::${m.name}_Validate`, 'calls', m.line, filePath, language));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// extract(): console variables and commands
// ---------------------------------------------------------------------------

const CVAR_RE =
  /\b(?:static\s+)?(TAutoConsoleVariable\s*<[^>]*>|FAutoConsoleVariableRef|FAutoConsoleVariable|FAutoConsoleCommandWithWorldAndArgs|FAutoConsoleCommandWithWorld|FAutoConsoleCommandWithArgsAndOutputDevice|FAutoConsoleCommandWithOutputDevice|FAutoConsoleCommandWithWorldArgsAndOutputDevice|FAutoConsoleCommand)\s+([A-Za-z_]\w*)\s*\(/g;

/** The literal of the n-th top-level argument when it is `TEXT("…")` or `"…"`. */
function stringArg(args: string[], n: number): string | null {
  const a = args[n];
  if (!a) return null;
  const m = /^(?:TEXT\s*\(\s*)?"((?:[^"\\]|\\.)*)"/.exec(a.trim());
  return m ? m[1]! : null;
}

function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += args[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === '>' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function extractConsoleVariables(filePath: string, source: string, out: FrameworkExtractionResult): void {
  if (!CPP_RE.test(filePath) || !/FAutoConsole|TAutoConsoleVariable/.test(source)) return;
  const code = blankComments(source);
  const flat = blankStrings(code);
  const lineAt = makeLineAt(source, 1);
  const language = cppLanguage(filePath);
  CVAR_RE.lastIndex = 0;
  for (let m = CVAR_RE.exec(flat); m; m = CVAR_RE.exec(flat)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(flat, open);
    if (close < 0) continue;
    const args = splitArgs(code.slice(open + 1, close));
    const consoleName = stringArg(args, 0);
    if (!consoleName) continue;
    const isCommand = m[1]!.startsWith('FAutoConsoleCommand');
    const help = stringArg(args, isCommand ? 1 : args.length - 1) ?? stringArg(args, 2);
    const line = lineAt(m.index + m[0].indexOf(m[2]!));
    const varName = m[2]!;
    const node = makeNode(filePath, 'constant', varName, `${filePath}::${varName}`, line, language, {
      signature: `${isCommand ? 'console command' : 'console variable'} "${consoleName}"`,
      docstring: help ?? undefined,
      isStatic: true,
    });
    out.nodes.push(node);
    if (isCommand) {
      const handler =
        /Create(?:Static|Raw|UObject|SP|Lambda)?\s*\(\s*(?:[A-Za-z_]\w*\s*,\s*)?&\s*([A-Za-z_][\w:]*)/.exec(code.slice(open, close));
      if (handler) out.references.push(ref(node.id, handler[1]!, 'references', line, filePath, language));
    } else if (m[1] === 'FAutoConsoleVariableRef' && args[1]) {
      const target = args[1].trim().replace(/^&/, '');
      if (/^[A-Za-z_][\w:]*$/.test(target)) out.references.push(ref(node.id, target, 'references', line, filePath, language));
    }
  }
}

// ---------------------------------------------------------------------------
// extract(): modules (.Build.cs)
// ---------------------------------------------------------------------------

const MODULE_QN = 'unreal-module:';

function extractModule(filePath: string, source: string, out: FrameworkExtractionResult): void {
  const cls = /\bclass\s+([A-Za-z_]\w*)\s*:\s*ModuleRules\b/.exec(source);
  if (!cls) return;
  const lineAt = makeLineAt(source, 1);
  const name = cls[1]!;
  const line = lineAt(cls.index);
  const node = makeNode(filePath, 'module', name, `${MODULE_QN}${name}`, line, 'csharp', {
    signature: `Unreal module ${name}`,
  });
  out.nodes.push(node);
  const seen = new Set<string>();
  const re = /\b(Public|Private)(?:Include)?DependencyModuleNames\s*\.\s*(?:AddRange|Add)\s*\(([\s\S]*?)\)\s*;/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m[0].includes('IncludePath')) continue;
    for (const s of m[2]!.matchAll(/"([A-Za-z_][\w]*)"/g)) {
      const dep = s[1]!;
      if (seen.has(dep)) continue;
      seen.add(dep);
      out.references.push(ref(node.id, `unreal:module:${dep}`, 'imports', lineAt(m.index), filePath, 'csharp'));
    }
  }
}

// ---------------------------------------------------------------------------
// extract(): config (.ini)
// ---------------------------------------------------------------------------

function extractIni(filePath: string, source: string, out: FrameworkExtractionResult): void {
  const lines = source.split(/\r?\n/);
  let section: { module: string; cls: string } | null = null;
  const seen = new Set<string>();
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith(';') || text.startsWith('#')) return;
    const sec = /^\[\/Script\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)\]$/.exec(text);
    if (sec) {
      section = { module: sec[1]!, cls: sec[2]! };
      return;
    }
    if (text.startsWith('[')) {
      section = null;
      return;
    }
    if (!section) return;
    const kv = /^[+\-.!]?([A-Za-z_]\w*)\s*=/.exec(text);
    if (!kv) return;
    const s = section as { module: string; cls: string };
    const key = `${s.cls}.${kv[1]}`;
    const line = i + 1;
    const id = generateNodeId(filePath, 'constant', `${key}@${line}`, line);
    if (seen.has(id)) return;
    seen.add(id);
    const node = makeNode(filePath, 'constant', key, `${filePath}::[/Script/${s.module}.${s.cls}]${kv[1]}`, line, 'properties', {
      signature: text.length > 160 ? `${text.slice(0, 157)}...` : text,
    }, id);
    out.nodes.push(node);
    out.references.push(ref(node.id, `unreal:config:${s.cls}::${kv[1]}`, 'references', line, filePath, 'properties'));
  });
}

// ---------------------------------------------------------------------------
// crossFileNodes(): UPROPERTY members and the delegate bindings that reach them
// ---------------------------------------------------------------------------

const PROPERTY_ID = 'unreal-prop:';
const BIND_RE = /([A-Za-z_]\w*)\s*(?:\.|->)\s*(AddDynamic|AddUniqueDynamic|BindDynamic|AddUFunction|BindUFunction)\s*\(/g;

interface Binding {
  /** Class the bound member is looked up on (the method's own class), or null. */
  ownerHint: string | null;
  member: string;
  handler: string;
}

/** `X.AddDynamic(this, &C::Handler)` in a C++ source. */
export function scanDelegateBindings(source: string): Binding[] {
  const code = blankComments(source);
  const flat = blankStrings(code);
  const out: Binding[] = [];
  // The class of the out-of-line method each offset sits in: `C::Method(...) {`.
  const defs: { cls: string; at: number }[] = [];
  for (const d of flat.matchAll(/\b([A-Za-z_]\w*)::~?[A-Za-z_]\w*\s*\([^;{}]*\)\s*(?:const\s*)?(?:override\s*)?\{/g)) {
    defs.push({ cls: d[1]!, at: d.index! });
  }
  BIND_RE.lastIndex = 0;
  for (let m = BIND_RE.exec(flat); m; m = BIND_RE.exec(flat)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(flat, open);
    if (close < 0) continue;
    const args = code.slice(open + 1, close);
    let handler: string | null = null;
    const amp = /&\s*([A-Za-z_][\w]*(?:::[A-Za-z_]\w*)+)/.exec(args);
    if (amp) handler = amp[1]!;
    else {
      const ufn = /(?:TEXT\s*\(\s*)?"([A-Za-z_]\w*)"|GET_FUNCTION_NAME_CHECKED\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(args);
      if (ufn) handler = ufn[1] ?? `${ufn[2]}::${ufn[3]}`;
    }
    if (!handler) continue;
    const receiverStart = m.index;
    const before = flat.slice(Math.max(0, receiverStart - 8), receiverStart);
    const viaThis = /this\s*->\s*$/.test(before) || !/[.>]\s*$/.test(before);
    let ownerHint: string | null = null;
    if (viaThis) {
      for (const d of defs) if (d.at < receiverStart) ownerHint = d.cls;
    }
    out.push({ ownerHint, member: m[1]!, handler });
  }
  return out;
}

const hash = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function buildPropertyNodes(context: ResolutionContext): CrossFileNodes {
  const files = context.getAllFiles();
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  // Every binding in the project, by member name.
  const bindings = new Map<string, Binding[]>();
  for (const f of files) {
    if (!CPP_RE.test(f)) continue;
    if (context.fileContains && !context.fileContains(f, 'Dynamic') && !context.fileContains(f, 'UFunction')) continue;
    const src = context.readFile(f);
    if (!src) continue;
    for (const b of scanDelegateBindings(src)) {
      const list = bindings.get(b.member) ?? [];
      list.push(b);
      bindings.set(b.member, list);
    }
  }

  for (const f of files) {
    if (!HEADER_RE.test(f)) continue;
    if (context.fileContains && !context.fileContains(f, 'UPROPERTY')) continue;
    const src = context.readFile(f);
    if (!src || !hasReflection(src)) continue;
    const language = cppLanguage(f);
    for (const m of scanReflection(src).members) {
      if (m.macro !== 'UPROPERTY' || !m.owner) continue;
      const qualifiedName = `${m.owner}::${m.name}`;
      const signature = `${macroSignature('UPROPERTY', m.specs)} ${m.declaration}`;
      const targets: { name: string; kind: UnresolvedRef['referenceKind'] }[] = [];
      const repUsing = specifierValue(m.specs, 'ReplicatedUsing');
      if (repUsing) targets.push({ name: `${m.owner}::${repUsing}`, kind: 'references' });
      const isDelegate = /^F[A-Z]\w*$/.test(m.type.replace(/\s+/g, '')) && bindings.has(m.name);
      if (isDelegate) {
        for (const b of bindings.get(m.name) ?? []) {
          if (b.ownerHint && b.ownerHint !== m.owner) {
            // Bound on `this` inside another class: that class may inherit the
            // member; keep it only when the class has no member of its own by
            // that name (checked cheaply by name below).
            if (context.getNodesByQualifiedName(`${b.ownerHint}::${m.name}`).length > 0) continue;
          }
          const handler = b.handler.includes('::') ? b.handler : `${b.ownerHint ?? m.owner}::${b.handler}`;
          targets.push({ name: handler, kind: 'calls' });
        }
      }
      const unique = [...new Map(targets.map((t) => [`${t.kind}:${t.name}`, t])).values()];
      const id = `${PROPERTY_ID}${f}::${qualifiedName}:${hash(signature + '|' + m.line + '|' + unique.map((t) => t.kind + t.name).join(','))}`;
      nodes.push(
        makeNode(f, 'property', m.name, qualifiedName, m.line, language, {
          signature,
          decorators: ['UPROPERTY', ...m.specs],
          visibility: 'public',
        }, id)
      );
      for (const t of unique) references.push(ref(id, t.name, t.kind, m.line, f, language));
    }
  }
  return { kind: 'property', nodes, references, owns: (n) => n.id.startsWith(PROPERTY_ID) };
}

// ---------------------------------------------------------------------------
// postExtract(): specifiers onto classes and method definitions
// ---------------------------------------------------------------------------

function decorate(node: Node, macro: string, specs: string[], declaration: string | null): Node | null {
  const sig = macroSignature(macro, specs);
  const decorators = [macro, ...specs];
  const signature = declaration ? `${sig} ${declaration}` : node.signature?.startsWith(sig) ? node.signature : `${sig}${node.signature ? ` ${node.signature}` : ''}`;
  if (node.signature === signature && JSON.stringify(node.decorators ?? []) === JSON.stringify(decorators)) return null;
  return { ...node, signature, decorators };
}

function decorateReflected(context: ResolutionContext): Node[] {
  const updates = new Map<string, Node>();
  for (const f of context.getAllFiles()) {
    if (!HEADER_RE.test(f)) continue;
    if (context.fileContains && !context.fileContains(f, 'GENERATED_') && !context.fileContains(f, 'UFUNCTION') && !context.fileContains(f, 'UENUM')) continue;
    const src = context.readFile(f);
    if (!src || !hasReflection(src)) continue;
    const scan = scanReflection(src);
    for (const t of scan.types) {
      const kinds: Node['kind'][] = t.keyword === 'enum' || t.keyword === 'namespace' ? ['enum', 'namespace'] : ['class', 'struct', 'interface'];
      for (const n of context.getNodesInFileNamed?.(f, t.name) ?? context.getNodesInFile(f).filter((x) => x.name === t.name)) {
        if (!kinds.includes(n.kind)) continue;
        const u = decorate(updates.get(n.id) ?? n, t.macro, t.specs, null);
        if (u) updates.set(n.id, u);
      }
    }
    for (const m of scan.members) {
      if (m.macro !== 'UFUNCTION' || !m.owner) continue;
      const names = [m.name];
      if (hasImplementationBody(m.specs)) names.push(`${m.name}_Implementation`);
      for (const name of names) {
        for (const n of context.getNodesByQualifiedName(`${m.owner}::${name}`)) {
          if (n.kind !== 'method' && n.kind !== 'function') continue;
          // The declaration node this resolver mints already carries its markup.
          if (n.decorators?.[0] === 'UFUNCTION' && n.filePath === f && n.startLine === m.line) continue;
          const u = decorate(updates.get(n.id) ?? n, 'UFUNCTION', m.specs, name === m.name ? m.declaration : null);
          if (u) updates.set(n.id, u);
        }
      }
    }
  }
  return [...updates.values()];
}

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

const DELEGATE_CALL_RE = /^(?:this->)?([A-Za-z_]\w*)\s*(?:\.|->)\s*(Broadcast|ExecuteIfBound|Execute)$/;
const CVAR_READ_RE =
  /^([A-Za-z_]\w*)\s*(?:\.|->)\s*(GetValueOnGameThread|GetValueOnAnyThread|GetValueOnRenderThread|AsVariable|GetInt|GetFloat|GetBool|GetString)$/;

function classOf(context: ResolutionContext, nodeId: string): string | null {
  const n = context.getNodeById?.(nodeId);
  if (!n) return null;
  const qn = n.qualifiedName;
  const i = qn.lastIndexOf('::');
  return i > 0 ? qn.slice(0, i).split('::').pop() ?? null : null;
}

function resolveUnreal(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;

  if (name.startsWith('unreal:module:')) {
    const mod = name.slice('unreal:module:'.length);
    const hit = context.getNodesByQualifiedName(`${MODULE_QN}${mod}`).find((n) => n.kind === 'module');
    return hit ? { original: ref, targetNodeId: hit.id, confidence: 0.95, resolvedBy: 'framework' } : null;
  }

  if (name.startsWith('unreal:config:')) {
    const [cls, key] = name.slice('unreal:config:'.length).split('::');
    if (!cls || !key) return null;
    for (const prefix of ['U', 'A', 'F', 'I', '']) {
      const hit = context.getNodesByQualifiedName(`${prefix}${cls}::${key}`).find((n) => n.kind === 'property');
      if (hit) return { original: ref, targetNodeId: hit.id, confidence: 0.9, resolvedBy: 'framework' };
    }
    return null;
  }

  const del = DELEGATE_CALL_RE.exec(name);
  if (del) {
    const props = context.getNodesByName(del[1]!).filter((n) => n.kind === 'property' && n.id.startsWith(PROPERTY_ID));
    if (props.length === 0) return null;
    const cls = classOf(context, ref.fromNodeId);
    const own = props.find((p) => cls && p.qualifiedName === `${cls}::${del[1]}`);
    const pick = own ?? (props.length === 1 ? props[0] : undefined);
    return pick ? { original: ref, targetNodeId: pick.id, confidence: own ? 0.9 : 0.7, resolvedBy: 'framework' } : null;
  }

  const cvar = CVAR_READ_RE.exec(name);
  if (cvar) {
    const hits = context
      .getNodesByName(cvar[1]!)
      .filter((n) => n.kind === 'constant' && /^console (variable|command) "/.test(n.signature ?? ''));
    const pick = hits.find((h) => h.filePath === ref.filePath) ?? (hits.length === 1 ? hits[0] : undefined);
    return pick
      ? { original: ref, targetNodeId: pick.id, confidence: 0.9, resolvedBy: 'framework', edgeKind: 'references' }
      : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export const unrealResolver: FrameworkResolver = {
  name: 'unreal',
  languages: ['cpp', 'c', 'csharp', 'properties'],

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles();
    if (files.some((f) => BUILD_CS_RE.test(f) || /\.Target\.cs$/.test(f))) return true;
    return files.some(
      (f) => HEADER_RE.test(f) && (context.fileContains ? context.fileContains(f, '.generated.h') : (context.readFile(f) ?? '').includes('.generated.h'))
    );
  },

  claimsReference(name: string): boolean {
    return name.startsWith('unreal:') || DELEGATE_CALL_RE.test(name) || CVAR_READ_RE.test(name);
  },

  resolve: resolveUnreal,

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const out: FrameworkExtractionResult = { nodes: [], references: [] };
    if (BUILD_CS_RE.test(filePath)) {
      extractModule(filePath, content, out);
    } else if (INI_RE.test(filePath)) {
      extractIni(filePath, content, out);
    } else if (CPP_RE.test(filePath)) {
      extractHeaderEvents(filePath, content, out);
      extractConsoleVariables(filePath, content, out);
    }
    return out;
  },

  postExtract(context: ResolutionContext): Node[] {
    return decorateReflected(context);
  },

  crossFileNodes(context: ResolutionContext): CrossFileNodes {
    return buildPropertyNodes(context);
  },
};
