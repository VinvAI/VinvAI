//! Symbol extraction via Tree-sitter (precise) for Python/JS/TS, plus a simple
//! heading-based chunker for documentation files.
//!
//! Each extracted symbol carries not just its span but the structural signals
//! the code graph needs: its enclosing container (`parent`), the identifiers it
//! calls (`calls`), and the types it extends (`bases`).

use std::sync::OnceLock;

use regex::Regex;
use tree_sitter::{Node, Parser};

use crate::config;

/// A raw extracted symbol, before summarizing/embedding.
pub struct Symbol {
    pub kind: String,
    pub name: String,
    pub start_line: usize, // 1-based, inclusive
    pub end_line: usize,   // 1-based, inclusive
    pub snippet: String,
    /// Nearest enclosing class/function name, if any.
    pub parent: Option<String>,
    /// Callee identifiers referenced in the body (for `invoke` edges).
    pub calls: Vec<String>,
    /// Base classes / supertypes (for `inherit` edges).
    pub bases: Vec<String>,
}

/// Map a file extension to a language name, or `None` if unsupported.
pub fn lang_for_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "py" | "pyi" => Some("python"),
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "ts" | "mts" | "cts" => Some("typescript"),
        "tsx" => Some("tsx"),
        "rs" => Some("rust"),
        "md" | "markdown" | "mdx" | "rst" | "txt" => Some("doc"),
        _ => None,
    }
}

/// Is this a code language (vs. a documentation file)?
pub fn is_code(lang: &str) -> bool {
    matches!(lang, "python" | "javascript" | "typescript" | "tsx" | "rust")
}

/// Extract symbols from `source` for the given language. `module_name` names
/// the synthetic per-file module chunk (typically the file stem).
pub fn extract(lang: &str, source: &str, module_name: &str) -> Vec<Symbol> {
    match lang {
        "python" | "javascript" | "typescript" | "tsx" | "rust" => {
            extract_code(lang, source, module_name)
        }
        "doc" => extract_doc(source),
        _ => Vec::new(),
    }
}

fn language(lang: &str) -> Option<tree_sitter::Language> {
    match lang {
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "javascript" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        _ => None,
    }
}

fn extract_code(lang: &str, source: &str, module_name: &str) -> Vec<Symbol> {
    let ts_lang = match language(lang) {
        Some(l) => l,
        None => return Vec::new(),
    };
    let mut parser = Parser::new();
    if parser.set_language(&ts_lang).is_err() {
        return Vec::new();
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    walk(tree.root_node(), bytes, lang, None, &mut out);
    if config::module_chunks() {
        let modules =
            extract_module_symbols(tree.root_node(), bytes, source, module_name, lang, &out);
        out.extend(modules);
    }
    out
}

/// Recursively descend, emitting a symbol for each definition node and
/// threading the enclosing class name down for method attribution.
fn walk(node: Node, src: &[u8], lang: &str, enclosing: Option<&str>, out: &mut Vec<Symbol>) {
    let mut cursor = node.walk();
    let children: Vec<Node> = node.children(&mut cursor).collect();
    for child in children {
        if let Some(kind) = def_kind(&child, lang, enclosing.is_some()) {
            if let Some(name) = def_name(&child, src) {
                let calls = extract_calls(&child, src, &name, lang);
                emit_symbol(&child, src, kind, &name, enclosing, calls, lang, out);
                let next = if matches!(kind, "class" | "struct" | "enum" | "trait") {
                    Some(name.as_str())
                } else {
                    enclosing
                };
                walk(child, src, lang, next, out);
                continue;
            }
        }
        // Rust `impl Foo { .. }` blocks are not symbols themselves, but they
        // name the type that owns the methods inside them.
        if child.kind() == "impl_item" {
            if let Some(type_name) = impl_type_name(&child, src) {
                walk(child, src, lang, Some(&type_name), out);
                continue;
            }
        }
        walk(child, src, lang, enclosing, out);
    }
}

/// The self type of a Rust `impl` block, without generic parameters:
/// `impl<T> Store<T> { .. }` -> `Store`.
fn impl_type_name(node: &Node, src: &[u8]) -> Option<String> {
    let type_node = node.child_by_field_name("type")?;
    let text = node_text(&type_node, src);
    let base = text.split('<').next().unwrap_or(text).trim();
    let base = base.rsplit("::").next().unwrap_or(base);
    if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    }
}

/// Emit a definition as one chunk, or — when it exceeds the line budget — as a
/// primary chunk plus AST-boundary continuation chunks. Nothing is truncated:
/// every source line of the definition lands in exactly one chunk, so large
/// function bodies stay visible to BM25, embeddings, and the graph.
#[allow(clippy::too_many_arguments)]
fn emit_symbol(
    node: &Node,
    src: &[u8],
    kind: &str,
    name: &str,
    enclosing: Option<&str>,
    calls: Vec<String>,
    lang: &str,
    out: &mut Vec<Symbol>,
) {
    let text = node_text(node, src);
    let bases = extract_bases(text, lang);
    let budget = config::max_snippet_lines();
    let start_row = node.start_position().row;
    let end_row = node.end_position().row;
    if end_row - start_row < budget {
        out.push(Symbol {
            kind: kind.to_string(),
            name: name.to_string(),
            start_line: start_row + 1,
            end_line: end_row + 1,
            snippet: text.to_string(),
            parent: enclosing.map(str::to_string),
            calls,
            bases,
        });
        return;
    }

    let mut points = Vec::new();
    ast_breakpoints(node, budget, &mut points);
    let spans = split_rows(start_row, end_row, budget, &points);
    let lines: Vec<&str> = text.lines().collect();
    let mut primary_calls = Some(calls);
    let mut primary_bases = Some(bases);
    for (position, (span_start, span_end)) in spans.iter().enumerate() {
        let rel_start = span_start - start_row;
        let rel_end = (span_end - start_row).min(lines.len().saturating_sub(1));
        if rel_start >= lines.len() {
            break;
        }
        let snippet = lines[rel_start..=rel_end].join("\n");
        if snippet.trim().is_empty() {
            continue;
        }
        out.push(Symbol {
            kind: kind.to_string(),
            name: name.to_string(),
            start_line: span_start + 1,
            end_line: span_end + 1,
            snippet,
            // Continuations parent to the symbol itself so a `contains` edge
            // links every part; the primary keeps the calls/bases and the
            // original enclosing container.
            parent: if position == 0 {
                enclosing.map(str::to_string)
            } else {
                Some(name.to_string())
            },
            calls: primary_calls.take().unwrap_or_default(),
            bases: primary_bases.take().unwrap_or_default(),
        });
    }
}

/// Rows where a named descendant starts — the legal AST cut points for
/// continuation chunking. Descends only into children that alone exceed the
/// budget, so the point set stays proportional to the oversized region.
fn ast_breakpoints(node: &Node, budget: usize, out: &mut Vec<usize>) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        out.push(child.start_position().row);
        if child.end_position().row - child.start_position().row + 1 > budget {
            ast_breakpoints(&child, budget, out);
        }
    }
}

/// Split `[start, end]` (inclusive rows) into contiguous spans of at most
/// `budget` lines, cutting at the deepest AST breakpoint available and only
/// falling back to a raw line cut when a single node exceeds the budget with
/// no internal structure.
fn split_rows(
    start: usize,
    end: usize,
    budget: usize,
    points: &[usize],
) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = start;
    while end - cursor + 1 > budget {
        let limit = cursor + budget;
        let cut = points
            .iter()
            .copied()
            .filter(|&point| point > cursor && point <= limit)
            .max()
            .unwrap_or(limit);
        spans.push((cursor, cut - 1));
        cursor = cut;
    }
    spans.push((cursor, end));
    spans
}

/// Synthesize per-file "module" symbols covering top-level code that no
/// definition owns: imports, constants, and module-level statements. Removes
/// the blind spot where `SKIP = [...]` at file scope was invisible to search.
/// Oversized module regions split into multiple chunks under the line budget.
fn extract_module_symbols(
    root: Node,
    src: &[u8],
    source: &str,
    module_name: &str,
    lang: &str,
    existing: &[Symbol],
) -> Vec<Symbol> {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut covered = vec![false; lines.len()];
    for symbol in existing {
        let end = symbol.end_line.min(lines.len());
        covered[symbol.start_line - 1..end]
            .iter_mut()
            .for_each(|flag| *flag = true);
    }

    // (row, text) pairs of module-level content, in file order.
    let module_rows: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(row, line)| !covered[*row] && !line.trim().is_empty())
        .map(|(row, line)| (row, *line))
        .collect();
    if module_rows.is_empty() {
        return Vec::new();
    }

    // Module-level calls: only from root children that live entirely on
    // uncovered rows (a block containing a nested def keeps its own edges).
    let mut calls = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        let child_rows = child.start_position().row..=child.end_position().row;
        if child_rows.clone().all(|row| row < covered.len() && !covered[row]) {
            collect_calls(child, src, module_name, lang, &mut calls);
        }
    }

    let budget = config::max_snippet_lines();
    let mut out = Vec::new();
    let mut primary_calls = Some(calls);
    for group in module_rows.chunks(budget) {
        let snippet = group.iter().map(|(_, line)| *line).collect::<Vec<_>>().join("\n");
        if snippet.trim().is_empty() {
            continue;
        }
        out.push(Symbol {
            kind: "module".to_string(),
            name: module_name.to_string(),
            start_line: group.first().map(|(row, _)| row + 1).unwrap_or(1),
            end_line: group.last().map(|(row, _)| row + 1).unwrap_or(1),
            snippet,
            parent: None,
            calls: primary_calls.take().unwrap_or_default(),
            bases: Vec::new(),
        });
    }
    out
}

/// Classify a node as a definition, or `None`. `in_class` distinguishes a
/// Python method from a free function.
fn def_kind(node: &Node, lang: &str, in_class: bool) -> Option<&'static str> {
    match node.kind() {
        "function_definition" => Some(if in_class { "method" } else { "function" }),
        "class_definition" | "class_declaration" | "abstract_class_declaration" => Some("class"),
        "function_declaration" | "generator_function_declaration" => Some("function"),
        "method_definition" => Some("method"),
        "interface_declaration" if matches!(lang, "typescript" | "tsx") => Some("interface"),
        "type_alias_declaration" if matches!(lang, "typescript" | "tsx") => Some("type"),
        "enum_declaration" if matches!(lang, "typescript" | "tsx") => Some("enum"),
        // `const foo = (..) => ..` / `const foo = function ..`
        "variable_declarator" => {
            let v = node.child_by_field_name("value")?;
            matches!(v.kind(), "arrow_function" | "function_expression" | "function")
                .then_some("function")
        }
        // Rust definitions.
        "function_item" if lang == "rust" => Some(if in_class { "method" } else { "function" }),
        "struct_item" | "union_item" if lang == "rust" => Some("struct"),
        "enum_item" if lang == "rust" => Some("enum"),
        "trait_item" if lang == "rust" => Some("trait"),
        "type_item" if lang == "rust" => Some("type"),
        "macro_definition" if lang == "rust" => Some("macro"),
        _ => None,
    }
}

fn def_name(node: &Node, src: &[u8]) -> Option<String> {
    let name_node = node.child_by_field_name("name")?;
    name_node.utf8_text(src).ok().map(str::to_string)
}

fn node_text<'a>(node: &Node, src: &'a [u8]) -> &'a str {
    std::str::from_utf8(&src[node.start_byte()..node.end_byte()]).unwrap_or("")
}

/// The callee path as written at the call site, receiver included and
/// normalized to `.` separators: `binary_controller.get_binary`, `Store.load`,
/// `self.run`.
///
/// The receiver is the only thing that distinguishes delegation to a same-named
/// function in another module from genuine self-recursion, so it is kept here
/// and stripped by consumers that want the bare name. Recording only the last
/// segment made `binary_controller.get_binary()` and `get_binary()` the same
/// string, which then forced a self-name filter that silently ate every
/// route -> controller delegation edge.
fn callable_path(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "property_identifier" | "private_property_identifier" => {
            Some(node_text(&node, src).trim_start_matches('#').to_string())
        }
        "attribute" => dotted_path(node, "object", "attribute", src),
        "member_expression" => dotted_path(node, "object", "property", src),
        // Rust: `value.method()` and `path::to::function()`.
        "field_expression" => dotted_path(node, "value", "field", src),
        "scoped_identifier" => dotted_path(node, "path", "name", src),
        "generic_function" => node
            .child_by_field_name("function")
            .and_then(|child| callable_path(child, src)),
        "parenthesized_expression" => node
            .named_child(0)
            .and_then(|child| callable_path(child, src)),
        _ => None,
    }
}

/// `<receiver>.<name>` for a call written through a receiver. A receiver that is
/// itself not a plain path (`make().run()`) keeps its source text so that the
/// call still reads as "through a receiver" rather than as a bare name.
fn dotted_path(node: Node, receiver_field: &str, name_field: &str, src: &[u8]) -> Option<String> {
    let name_node = node.child_by_field_name(name_field)?;
    let name = node_text(&name_node, src).trim_start_matches('#').to_string();
    if name.is_empty() {
        return None;
    }
    let receiver = node.child_by_field_name(receiver_field).map(|r| {
        callable_path(r, src)
            .unwrap_or_else(|| node_text(&r, src).split_whitespace().collect::<String>())
    });
    Some(match receiver {
        Some(r) if !r.is_empty() => format!("{r}.{name}"),
        _ => name,
    })
}

/// Split a callee path into `(receiver, bare name)`.
fn split_path(path: &str) -> (&str, &str) {
    match path.rsplit_once('.') {
        Some((receiver, name)) => (receiver, name),
        None => ("", path),
    }
}

/// Record a callee path against the enclosing symbol `own`.
///
/// The self-name check applies only to a bare call or one through `self`/`cls`/
/// `this` — those are real recursion, and the graph drops them as self-loops
/// anyway. A call through any other receiver is delegation to a different
/// module and must be kept even when it shares the caller's name, which is the
/// overwhelmingly common FastAPI shape:
///
/// ```python
/// async def get_binary(...):
///     return await binary_controller.get_binary(session, binary_id)
/// ```
///
/// The keyword/noise filter applies to bare calls (where a builtin like
/// `len(...)` is textually identical to a project call) and to Rust, whose
/// std method names the list was written for. A dotted Python/JS call is
/// always recorded: its receiver survives to resolution, which either places
/// it (`binary_controller.get_binary`) or reports it as an external leaf
/// (`session.get`) — dropping it here erased real calls, most visibly every
/// ORM access, from the call tree.
fn push_call(path: &str, own: &str, lang: &str, seen: &mut Vec<String>) {
    let (receiver, name) = split_path(path);
    if name.is_empty() {
        return;
    }
    let receiver_root = receiver.split('.').next().unwrap_or("");
    let is_self_call = receiver.is_empty() || matches!(receiver_root, "self" | "cls" | "this");
    if is_self_call && name == own {
        return;
    }
    let is_noise = is_keyword(name) || (lang == "rust" && is_rust_std_method(name));
    if (receiver.is_empty() || lang == "rust") && is_noise {
        return;
    }
    if seen.iter().any(|s| s == path) {
        return;
    }
    seen.push(path.to_string());
}

fn collect_calls(node: Node, src: &[u8], own: &str, lang: &str, seen: &mut Vec<String>) {
    if matches!(node.kind(), "call" | "call_expression" | "new_expression") {
        let callee_node = node
            .child_by_field_name("function")
            .or_else(|| node.child_by_field_name("constructor"));
        if let Some(callee_node) = callee_node {
            if let Some(callee) = callable_path(callee_node, src) {
                push_call(&callee, own, lang, seen);
                // Match the dispatcher on the bare name: the path now carries a
                // receiver (`asyncio.to_thread`, `loop.run_in_executor`).
                let (_, dispatcher) = split_path(&callee);
                let dispatched_position = match dispatcher {
                    "run_in_executor" => Some(1),
                    "to_thread" | "submit" | "apply_async" | "spawn" | "add_done_callback"
                    | "partial" => Some(0),
                    _ => None,
                };
                if let Some(position) = dispatched_position {
                    if let Some(arguments) = node.child_by_field_name("arguments") {
                        if let Some(argument) = arguments.named_child(position) {
                            if let Some(target) = callable_path(argument, src) {
                                push_call(&target, own, lang, seen);
                            }
                        }
                    }
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_calls(child, src, own, lang, seen);
    }
}

/// Callee identifiers from actual Tree-sitter call nodes. Comments and string
/// literals cannot become graph edges because they contain no call nodes.
fn extract_calls(node: &Node, src: &[u8], own: &str, lang: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    collect_calls(*node, src, own, lang, &mut seen);
    seen
}

fn bases_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Python `class X(A, B):` or JS/TS `class X extends A`.
    RE.get_or_init(|| {
        Regex::new(r"class\s+[A-Za-z0-9_$]+\s*(?:\(([^)]*)\)|extends\s+([A-Za-z0-9_$.]+))").unwrap()
    })
}

fn extract_bases(snippet: &str, _lang: &str) -> Vec<String> {
    let caps = match bases_regex().captures(snippet) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Some(py) = caps.get(1) {
        for part in py.as_str().split(',') {
            let base = part.trim().split('=').next().unwrap_or("").trim();
            let base = base.rsplit('.').next().unwrap_or(base); // strip module prefix
            if !base.is_empty() && base != "object" && !base.contains(char::is_whitespace) {
                out.push(base.to_string());
            }
        }
    }
    if let Some(js) = caps.get(2) {
        let base = js.as_str().rsplit('.').next().unwrap_or(js.as_str());
        if !base.is_empty() {
            out.push(base.to_string());
        }
    }
    out
}

/// Names filtered out of `calls` — but only for bare calls and for Rust (see
/// `push_call`): keywords, Python/JS builtins that a bare call cannot be told
/// apart from, and Rust std method noise. A dotted Python/JS call bypasses
/// this filter entirely; the resolution layer judges it by its receiver.
/// Language keywords and universal builtins. Textually identical to a call, but
/// never a project symbol in any language, so they are noise as a bare callee
/// regardless of what is being indexed.
fn is_keyword(w: &str) -> bool {
    matches!(
        w,
        "if" | "for" | "while" | "switch" | "catch" | "return" | "function" | "await"
            | "yield" | "typeof" | "new" | "delete" | "void" | "in" | "of" | "case"
            | "default" | "const" | "let" | "var" | "class" | "super" | "this" | "and"
            | "or" | "not" | "print" | "range" | "len" | "str" | "int" | "list" | "dict"
            | "set" | "tuple" | "isinstance" | "type" | "self"
    )
}

/// Ubiquitous Rust std methods. Noise in Rust, where they appear on every other
/// line and would bind to any local symbol sharing the name — but ordinary
/// project names elsewhere (`collect`, `find`, `count`, `take`, `contains`,
/// `push`, `matches` are all plausible Python/JS functions). Gated on `lang`
/// rather than folded into `is_keyword`, which previously erased those calls
/// from every non-Rust call tree.
fn is_rust_std_method(w: &str) -> bool {
    matches!(
        w,
        "unwrap" | "expect" | "clone" | "into" | "to_string" | "iter"
            | "into_iter" | "collect" | "map" | "and_then" | "or_else" | "ok"
            | "err" | "as_str" | "as_ref" | "as_deref" | "push" | "insert" | "get"
            | "is_empty" | "filter" | "unwrap_or" | "unwrap_or_else"
            | "unwrap_or_default" | "to_owned" | "contains" | "join" | "trim"
            | "split" | "next" | "enumerate" | "extend" | "entry" | "or_default"
            | "format" | "matches" | "sort_by" | "partial_cmp" | "cmp" | "min"
            | "max" | "take" | "find" | "any" | "all" | "sum" | "count" | "lines"
            | "chars"
    )
}

// ---------------------------------------------------------------------------
// Documentation files — heading-based chunking.
// ---------------------------------------------------------------------------

fn extract_doc(source: &str) -> Vec<Symbol> {
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut heading = first_nonempty(&lines).unwrap_or("document").to_string();

    let budget = config::max_snippet_lines();
    let flush = |from: usize, to: usize, title: &str, out: &mut Vec<Symbol>| {
        if to < from {
            return;
        }
        let to = to.min(lines.len().saturating_sub(1));
        // Oversized sections split into consecutive chunks under the budget —
        // no documentation content is silently dropped.
        let mut cursor = from;
        while cursor <= to {
            let end = (cursor + budget - 1).min(to);
            let text = lines[cursor..=end].join("\n");
            if !text.trim().is_empty() {
                out.push(Symbol {
                    kind: "doc".to_string(),
                    name: title.trim().trim_start_matches('#').trim().to_string(),
                    start_line: cursor + 1,
                    end_line: end + 1,
                    snippet: text,
                    parent: None,
                    calls: Vec::new(),
                    bases: Vec::new(),
                });
            }
            cursor = end + 1;
        }
    };

    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with('#') && i > start {
            flush(start, i - 1, &heading, &mut out);
            start = i;
            heading = line.to_string();
        }
    }
    flush(start, lines.len().saturating_sub(1), &heading, &mut out);
    out
}

fn first_nonempty<'a>(lines: &[&'a str]) -> Option<&'a str> {
    lines.iter().map(|l| l.trim()).find(|l| !l.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsx_uses_the_jsx_aware_grammar() {
        let source = r#"
interface Props { name: string }
export function Greeting({ name }: Props) {
  return <div>{formatName(name)}</div>;
}
export const Arrow = ({ name }: Props) => <span>{formatName(name)}</span>;
"#;
        let symbols = extract("tsx", source, "widget");
        assert!(symbols.iter().any(|symbol| symbol.name == "Greeting"));
        assert!(symbols.iter().any(|symbol| symbol.name == "Arrow"));
    }

    #[test]
    fn calls_ignore_comments_and_string_literals() {
        let source = r#"
def target():
    # fake_comment()
    text = "fake_string()"
    real_call()
"#;
        let symbols = extract("python", source, "mod");
        let target = symbols.iter().find(|symbol| symbol.name == "target").unwrap();
        assert_eq!(target.calls, vec!["real_call"]);
    }

    #[test]
    fn dispatched_callable_is_still_an_invoke_target() {
        let source = r#"
async def target():
    await asyncio.to_thread(worker)
"#;
        let symbols = extract("python", source, "mod");
        let target = symbols.iter().find(|symbol| symbol.name == "target").unwrap();
        assert!(target.calls.iter().any(|call| call == "worker"));
    }

    #[test]
    fn oversized_symbols_split_into_linked_continuations_without_loss() {
        // A function far beyond the budget must land in multiple chunks whose
        // snippets, concatenated, contain every body line.
        std::env::set_var("INDEX_MAX_SNIPPET_LINES", "20");
        let body: String = (0..70)
            .map(|i| format!("    value_{i} = compute_{i}()\n"))
            .collect();
        let source = format!("def big():\n{body}");
        let symbols = extract("python", &source, "mod");
        std::env::remove_var("INDEX_MAX_SNIPPET_LINES");

        let parts: Vec<&Symbol> =
            symbols.iter().filter(|s| s.name == "big" && s.kind == "function").collect();
        assert!(parts.len() >= 4, "expected continuation chunks, got {}", parts.len());
        let joined: String = parts.iter().map(|s| s.snippet.as_str()).collect();
        for i in 0..70 {
            assert!(
                joined.contains(&format!("value_{i} ")),
                "line {i} was lost by chunking"
            );
        }
        // Continuations parent to the primary symbol for `contains` linkage.
        assert!(parts[1..].iter().all(|s| s.parent.as_deref() == Some("big")));
        // No chunk exceeds the budget.
        assert!(parts.iter().all(|s| s.snippet.lines().count() <= 20));
    }

    #[test]
    fn module_level_code_becomes_a_module_symbol() {
        let source = r#"
import os

SKIP_DIRS = ["node_modules", ".git"]

configure_logging()

def helper():
    return SKIP_DIRS
"#;
        let symbols = extract("python", source, "settings");
        let module = symbols.iter().find(|s| s.kind == "module").unwrap();
        assert_eq!(module.name, "settings");
        assert!(module.snippet.contains("SKIP_DIRS"));
        assert!(module.snippet.contains("import os"));
        // Lines owned by the function are not duplicated into the module chunk.
        assert!(!module.snippet.contains("return SKIP_DIRS"));
        // Top-level invocations feed the graph.
        assert!(module.calls.iter().any(|c| c == "configure_logging"));
    }

    #[test]
    fn rust_symbols_methods_and_calls_are_extracted() {
        let source = r#"
pub struct Store {
    pub dim: usize,
}

impl Store {
    pub fn load(dir: PathBuf) -> Option<Store> {
        let meta = read_meta(&dir)?;
        Some(Store { dim: meta.dim })
    }
}

pub fn read_meta(dir: &Path) -> Option<Meta> {
    serde_json::from_str(&fs::read_to_string(dir).ok()?).ok()
}
"#;
        let symbols = extract("rust", source, "store");
        let store = symbols.iter().find(|s| s.name == "Store").unwrap();
        assert_eq!(store.kind, "struct");
        let load = symbols.iter().find(|s| s.name == "load").unwrap();
        assert_eq!(load.kind, "method");
        assert_eq!(load.parent.as_deref(), Some("Store"));
        assert!(load.calls.iter().any(|c| c == "read_meta"));
        let free = symbols.iter().find(|s| s.name == "read_meta").unwrap();
        assert_eq!(free.kind, "function");
        // Receiver-aware contract: the callee path keeps its receiver so
        // resolution can tell delegation from recursion.
        assert!(free.calls.iter().any(|c| c == "serde_json.from_str"));
    }

    #[test]
    fn split_rows_prefers_ast_breakpoints_and_never_drops_lines() {
        let spans = split_rows(0, 99, 40, &[10, 35, 60, 85]);
        // Full coverage, contiguous, within budget.
        assert_eq!(spans.first().unwrap().0, 0);
        assert_eq!(spans.last().unwrap().1, 99);
        for window in spans.windows(2) {
            assert_eq!(window[0].1 + 1, window[1].0);
        }
        assert!(spans.iter().all(|(s, e)| e - s < 40));
        // Cuts land on breakpoints where possible.
        assert_eq!(spans[0].1, 34);
    }
}
