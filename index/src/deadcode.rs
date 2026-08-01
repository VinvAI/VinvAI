//! `index deadcode` — scope-aware dead-code detection for Python.
//!
//! Source only: this deliberately does NOT read the index store. The graph's
//! `invoke` edges are resolved by name (see `graph::resolve`), and when two
//! symbols share a name the calls collapse onto one of them — so the other
//! reads as uncalled. That error deletes working code, which is the one
//! outcome a dead-code report must never produce, so reachability here is
//! recomputed from the AST every run.
//!
//! Two questions are answered separately, because the answers lead to
//! different actions:
//!
//!   UNREACHABLE — nothing in the repository references it, tests included.
//!   TEST-ONLY   — the suite reaches it and no product path does. Tested code
//!                 that was never wired in; the tests would go with it.
//!
//! Both are computed rather than guessed: the analysis runs twice, once with
//! test files parsed and once without, and the buckets are the difference.
//!
//! Everything a framework dispatches is a LIVE ROOT before reachability runs,
//! not a filter applied to the results afterwards. `__post_init__` is never
//! named by anything, so classifying it at report time left it "dead" and
//! discarded the calls it makes — which then read as dead in turn.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tree_sitter::{Node, Parser};

/// Directories never walked. Mirrors the Python original exactly so the two
/// implementations can be compared finding for finding.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".vinv",
    ".mypy_cache", ".pytest_cache", ".tox", "site-packages",
];

const TEST_DIRS: &[&str] = &["tests", "test", "testing", "__tests__", "testsuite"];

/// Decorator sources that are language machinery. A decorator resolving to any
/// other module means the framework calls the function, so it is a live root.
/// `@staticmethod` and `@dataclass` say nothing about who calls it — treating
/// every decorator as dispatch hid four genuinely dead symbols.
const STDLIB_DECORATOR_MODULES: &[&str] = &[
    "builtins", "functools", "dataclasses", "typing", "typing_extensions", "abc", "contextlib",
    "enum", "atexit", "warnings",
];

const BARE_STDLIB_DECORATORS: &[&str] = &[
    "staticmethod", "classmethod", "property", "cached_property", "abstractmethod",
    "abstractproperty", "dataclass", "wraps", "overload", "override", "final", "total_ordering",
    "lru_cache", "cache", "contextmanager", "asynccontextmanager", "singledispatch",
    "singledispatchmethod", "setter", "getter", "deleter",
];

/// Which scope a reference was made from. Module-level code runs on import; a
/// def's references only count once that def is itself known reachable.
#[derive(Clone, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
enum Scope {
    Module(String),
    Def(String, usize),
    ClassBody(String, usize),
}

#[derive(Clone, Debug)]
struct Def {
    name: String,
    kind: &'static str, // "function" | "method" | "class"
    file: String,
    line: usize,
    end: usize,
    /// (name, resolved module) per decorator.
    decorators: Vec<(String, Option<String>)>,
    bases: Vec<String>,
    parent: Scope,
    ambiguous: bool,
    /// Dead symbols that reference this one, as `file:line:name`.
    ///
    /// A symbol with an empty list is the TOP of its chain: nothing at all
    /// points at it. A non-empty list means it is dead only because its callers
    /// are — "nothing references this" would be false, and saying it invites an
    /// agent to find the caller and rightly answer "still used".
    dead_callers: Vec<String>,
}

impl Def {
    fn key(&self) -> (String, usize, String) {
        (self.file.clone(), self.line, self.name.clone())
    }
}

#[derive(Default)]
struct FileFacts {
    defs: Vec<Def>,
    refs: HashMap<Scope, HashSet<String>>,
    binds: HashMap<Scope, HashSet<String>>,
    strings: HashSet<String>,
    imports: HashMap<String, String>,
    exports: HashSet<String>,
    reexports: HashSet<String>,
    escape_seeds: HashSet<String>,
}

// ---------------------------------------------------------------------------
// walking the tree
// ---------------------------------------------------------------------------

fn text<'a>(node: &Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

fn is_test_file(rel: &str) -> bool {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    if base.starts_with("test_") || base.ends_with("_test.py") || base == "conftest.py" {
        return true;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    parts[..parts.len().saturating_sub(1)]
        .iter()
        .any(|p| TEST_DIRS.contains(p))
}

fn py_files(root: &Path, skip_tests: bool) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
            } else if name.ends_with(".py") {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if skip_tests && is_test_file(&rel) {
                    continue;
                }
                out.push((rel, path));
            }
        }
    }
    out.sort();
    out
}

/// The identifier a decorator ultimately names, plus the module it came from.
fn decorator_root(node: &Node, src: &[u8], imports: &HashMap<String, String>) -> Option<(String, Option<String>)> {
    let mut cur = *node;
    loop {
        match cur.kind() {
            "call" => cur = cur.child_by_field_name("function")?,
            "attribute" => cur = cur.child_by_field_name("object")?,
            "identifier" => {
                let name = text(&cur, src).to_string();
                let module = imports.get(&name).cloned();
                return Some((name, module));
            }
            _ => return None,
        }
    }
}

/// A string literal's content, quotes and prefixes removed.
fn string_content(node: &Node, src: &[u8]) -> String {
    let raw = text(node, src);
    let trimmed = raw.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    for q in ["\"\"\"", "'''", "\"", "'"] {
        if let Some(rest) = trimmed.strip_prefix(q) {
            return rest.strip_suffix(q).unwrap_or(rest).to_string();
        }
    }
    trimmed.to_string()
}

/// Names bound by a target expression: `a`, `a, b`, `[a, b]`, `a.b` (not a
/// local), `a[i]` (not a local).
fn target_names(node: &Node, src: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        "identifier" => out.push(text(node, src).to_string()),
        "pattern_list" | "tuple_pattern" | "list_pattern" | "tuple" | "list" => {
            let mut c = node.walk();
            for child in node.children(&mut c) {
                target_names(&child, src, out);
            }
        }
        _ => {}
    }
}

struct Walker<'a> {
    src: &'a [u8],
    rel: String,
    facts: FileFacts,
    stack: Vec<Scope>,
    docstrings: HashSet<usize>,
}

impl<'a> Walker<'a> {
    fn scope(&self) -> Scope {
        self.stack.last().cloned().unwrap()
    }

    fn add_ref(&mut self, name: &str) {
        let s = self.scope();
        self.facts.refs.entry(s).or_default().insert(name.to_string());
    }

    /// Record a name as LOCAL to the current scope.
    ///
    /// Python settles this statically: a name assigned anywhere in a scope is
    /// local to that whole scope, so a load of it cannot reach a module-level
    /// def. This is the language rule, not a heuristic, and it is what stops a
    /// `Path` variable named `emit` in one package's tests from counting as a
    /// call to another package's `emit`. Imports are deliberately not bindings:
    /// `from .mod import foo` binds `foo` locally AND is a real reference.
    fn add_bind(&mut self, name: &str) {
        let s = self.scope();
        self.facts.binds.entry(s).or_default().insert(name.to_string());
    }

    /// Mark the docstring of a module/def/class body so it is not read as a
    /// dynamic reference. A name in prose is documentation, not a call.
    fn mark_docstring(&mut self, body: &Node) {
        let mut c = body.walk();
        let first = body.children(&mut c).find(|n| n.is_named());
        if let Some(first) = first {
            if first.kind() == "expression_statement" {
                let mut c2 = first.walk();
                let inner = first.children(&mut c2).find(|n| n.is_named());
                if let Some(inner) = inner {
                    if inner.kind() == "string" {
                        self.docstrings.insert(inner.id());
                    }
                }
            }
        }
    }

    fn params(&mut self, func: &Node) {
        if let Some(params) = func.child_by_field_name("parameters") {
            let mut c = params.walk();
            for p in params.children(&mut c) {
                match p.kind() {
                    "identifier" => {
                        let n = text(&p, self.src).to_string();
                        self.add_bind(&n);
                    }
                    "typed_parameter" | "default_parameter" | "typed_default_parameter"
                    | "list_splat_pattern" | "dictionary_splat_pattern" => {
                        let mut c2 = p.walk();
                        if let Some(id) = p.children(&mut c2).find(|n| n.kind() == "identifier") {
                            let n = text(&id, self.src).to_string();
                            self.add_bind(&n);
                        }
                        // Annotation and default are both expressions, and both
                        // reference names.
                        if let Some(t) = p.child_by_field_name("type") {
                            self.visit(&t);
                        }
                        if let Some(v) = p.child_by_field_name("value") {
                            self.visit(&v);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn definition(&mut self, node: &Node, decorated: Option<&Node>) {
        let name_node = match node.child_by_field_name("name") {
            Some(n) => n,
            None => return,
        };
        let name = text(&name_node, self.src).to_string();
        let is_class = node.kind() == "class_definition";
        let parent = self.scope();
        let kind = if is_class {
            "class"
        } else if matches!(parent, Scope::ClassBody(_, _)) {
            "method"
        } else {
            "function"
        };

        let mut decorators = Vec::new();
        if let Some(dec) = decorated {
            let mut c = dec.walk();
            for child in dec.children(&mut c) {
                if child.kind() == "decorator" {
                    let mut c2 = child.walk();
                    let expr = child.children(&mut c2).find(|n| n.is_named());
                    if let Some(expr) = expr {
                        if let Some(found) = decorator_root(&expr, self.src, &self.facts.imports) {
                            decorators.push(found);
                        }
                    }
                }
            }
        }

        let mut bases = Vec::new();
        if let Some(supers) = node.child_by_field_name("superclasses") {
            let mut c = supers.walk();
            for b in supers.children(&mut c) {
                if b.is_named() {
                    bases.push(text(&b, self.src).to_string());
                }
            }
        }

        // The reported line is the `def`/`class` line, matching Python's
        // node.lineno — decorators sit above it and are not part of the span.
        let line = node.start_position().row + 1;
        let end = node.end_position().row + 1;
        self.facts.defs.push(Def {
            name,
            kind,
            file: self.rel.clone(),
            line,
            end,
            decorators,
            bases,
            parent,
            ambiguous: false,
            dead_callers: Vec::new(),
        });

        // Decorator expressions and base lists are evaluated in the ENCLOSING
        // scope, so visit them before descending.
        if let Some(dec) = decorated {
            let mut c = dec.walk();
            for child in dec.children(&mut c) {
                if child.kind() == "decorator" {
                    let mut c2 = child.walk();
                    for e in child.children(&mut c2) {
                        if e.is_named() {
                            self.visit(&e);
                        }
                    }
                }
            }
        }
        if let Some(supers) = node.child_by_field_name("superclasses") {
            self.visit(&supers);
        }

        self.stack.push(if is_class {
            Scope::ClassBody(self.rel.clone(), line)
        } else {
            Scope::Def(self.rel.clone(), line)
        });
        if !is_class {
            self.params(node);
            if let Some(rt) = node.child_by_field_name("return_type") {
                self.visit(&rt);
            }
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.mark_docstring(&body);
            self.visit(&body);
        }
        self.stack.pop();
    }

    fn visit(&mut self, node: &Node) {
        match node.kind() {
            "decorated_definition" => {
                let mut c = node.walk();
                let inner = node
                    .children(&mut c)
                    .find(|n| matches!(n.kind(), "function_definition" | "class_definition"));
                if let Some(def) = inner {
                    self.definition(&def, Some(node));
                }
                return;
            }
            "function_definition" | "class_definition" => {
                self.definition(node, None);
                return;
            }
            "import_statement" => {
                let mut c = node.walk();
                for child in node.children(&mut c) {
                    let (alias, full) = match child.kind() {
                        "dotted_name" => (text(&child, self.src), text(&child, self.src)),
                        "aliased_import" => {
                            let n = child.child_by_field_name("name");
                            let a = child.child_by_field_name("alias");
                            match (n, a) {
                                (Some(n), Some(a)) => (text(&a, self.src), text(&n, self.src)),
                                _ => continue,
                            }
                        }
                        _ => continue,
                    };
                    let root = alias.split('.').next().unwrap_or(alias).to_string();
                    let module = full.split('.').next().unwrap_or(full).to_string();
                    self.facts.imports.insert(root, module);
                }
                // Import targets are not references (Python's ast has no Name
                // nodes here); the names become roots via `reexports` instead.
                return;
            }
            "import_from_statement" => {
                let module = node
                    .child_by_field_name("module_name")
                    .map(|m| text(&m, self.src).trim_start_matches('.').to_string())
                    .unwrap_or_default();
                let module_root = module.split('.').next().unwrap_or(&module).to_string();
                let mut c = node.walk();
                for child in node.children(&mut c) {
                    if Some(child) == node.child_by_field_name("module_name") {
                        continue;
                    }
                    let (local, imported) = match child.kind() {
                        "dotted_name" => (text(&child, self.src), text(&child, self.src)),
                        "aliased_import" => {
                            let n = child.child_by_field_name("name");
                            let a = child.child_by_field_name("alias");
                            match (n, a) {
                                (Some(n), Some(a)) => (text(&a, self.src), text(&n, self.src)),
                                _ => continue,
                            }
                        }
                        _ => continue,
                    };
                    self.facts
                        .imports
                        .insert(local.to_string(), module_root.clone());
                    self.facts.reexports.insert(imported.to_string());
                }
                return;
            }
            "assignment" => {
                let left = node.child_by_field_name("left");
                let right = node.child_by_field_name("right");
                if let Some(left) = left {
                    // __all__ = [...] → declared public API
                    if left.kind() == "identifier" && text(&left, self.src) == "__all__" {
                        if let Some(r) = right {
                            let mut stack = vec![r];
                            while let Some(n) = stack.pop() {
                                if n.kind() == "string" {
                                    let s = string_content(&n, self.src);
                                    self.facts.exports.insert(s);
                                }
                                let mut c = n.walk();
                                for ch in n.children(&mut c) {
                                    stack.push(ch);
                                }
                            }
                        }
                    }
                    // module.Attr = X / sys.modules[k] = X → X escapes into a
                    // namespace foreign code holds.
                    if matches!(left.kind(), "attribute" | "subscript") {
                        if let Some(r) = right {
                            match r.kind() {
                                "identifier" => {
                                    let s = text(&r, self.src).to_string();
                                    self.facts.escape_seeds.insert(s);
                                }
                                "attribute" => {
                                    if let Some(a) = r.child_by_field_name("attribute") {
                                        let s = text(&a, self.src).to_string();
                                        self.facts.escape_seeds.insert(s);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    let mut names = Vec::new();
                    target_names(&left, self.src, &mut names);
                    for n in names {
                        self.add_bind(&n);
                    }
                    // An attribute/subscript target still REFERENCES its object.
                    if matches!(left.kind(), "attribute" | "subscript") {
                        self.visit(&left);
                    }
                }
                // `x: Foo = ...` — the ANNOTATION references Foo. Python's ast
                // records it as a Name load; dropping it made every class used
                // only as a field type look unreferenced.
                if let Some(t) = node.child_by_field_name("type") {
                    self.visit(&t);
                }
                if let Some(r) = right {
                    self.visit(&r);
                }
                return;
            }
            "for_statement" | "for_in_clause" => {
                if let Some(left) = node.child_by_field_name("left") {
                    let mut names = Vec::new();
                    target_names(&left, self.src, &mut names);
                    for n in names {
                        self.add_bind(&n);
                    }
                }
            }
            "as_pattern" => {
                // `with x as y`, `except E as y` — y is bound locally.
                if let Some(alias) = node.child_by_field_name("alias") {
                    let mut names = Vec::new();
                    target_names(&alias, self.src, &mut names);
                    for n in names {
                        self.add_bind(&n);
                    }
                }
            }
            "except_clause" => {
                let mut c = node.walk();
                for child in node.children(&mut c) {
                    if child.kind() == "identifier" {
                        // `except E as name:` spells the name as a bare
                        // identifier in some grammar versions.
                        let prev = child.prev_sibling().map(|p| text(&p, self.src).to_string());
                        if prev.as_deref() == Some("as") {
                            let n = text(&child, self.src).to_string();
                            self.add_bind(&n);
                        }
                    }
                }
            }
            "named_expression" => {
                if let Some(t) = node.child_by_field_name("name") {
                    let n = text(&t, self.src).to_string();
                    self.add_bind(&n);
                }
            }
            "call" => {
                // setattr(obj, name, X) → X escapes.
                if let Some(f) = node.child_by_field_name("function") {
                    if f.kind() == "identifier" && text(&f, self.src) == "setattr" {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let mut c = args.walk();
                            let named: Vec<Node> =
                                args.children(&mut c).filter(|n| n.is_named()).collect();
                            if named.len() == 3 {
                                match named[2].kind() {
                                    "identifier" => {
                                        let s = text(&named[2], self.src).to_string();
                                        self.facts.escape_seeds.insert(s);
                                    }
                                    "attribute" => {
                                        if let Some(a) = named[2].child_by_field_name("attribute") {
                                            let s = text(&a, self.src).to_string();
                                            self.facts.escape_seeds.insert(s);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
            "attribute" => {
                // Python's visit_Attribute records the attribute NAME; the
                // object is visited as an ordinary load.
                if let Some(a) = node.child_by_field_name("attribute") {
                    let n = text(&a, self.src).to_string();
                    self.add_ref(&n);
                }
                if let Some(o) = node.child_by_field_name("object") {
                    self.visit(&o);
                }
                return;
            }
            "keyword_argument" => {
                // `f(key=value)` — `key` is not a reference (ast stores it as a
                // plain string, not a Name).
                if let Some(v) = node.child_by_field_name("value") {
                    self.visit(&v);
                }
                return;
            }
            "identifier" => {
                let n = text(node, self.src).to_string();
                self.add_ref(&n);
                return;
            }
            "string" => {
                if !self.docstrings.contains(&node.id()) {
                    let s = string_content(node, self.src);
                    self.facts.strings.insert(s);
                }
                // interpolations inside f-strings still reference names
                let mut c = node.walk();
                for child in node.children(&mut c) {
                    if child.kind() == "interpolation" {
                        self.visit(&child);
                    }
                }
                return;
            }
            _ => {}
        }
        let mut c = node.walk();
        for child in node.children(&mut c) {
            self.visit(&child);
        }
    }
}

fn parse_file(rel: &str, source: &str) -> Option<FileFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let src = source.as_bytes();
    let mut w = Walker {
        src,
        rel: rel.to_string(),
        facts: FileFacts::default(),
        stack: vec![Scope::Module(rel.to_string())],
        docstrings: HashSet::new(),
    };
    let root = tree.root_node();
    w.mark_docstring(&root);
    let mut c = root.walk();
    for child in root.children(&mut c) {
        w.visit(&child);
    }
    Some(w.facts)
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

struct Analysis {
    /// How many definitions carry each name in THIS run. Ambiguity is judged
    /// against the tests-included census, because a name that collides only
    /// with a test helper is still a name whose references cannot be attributed.
    name_counts: HashMap<String, usize>,
    dead: Vec<Def>,
    probable: Vec<Def>,
    excluded: Vec<(String, usize)>,
    files: usize,
    defs: usize,
}

fn entry_point_names(root: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(blob) = fs::read_to_string(root.join("pyproject.toml")) {
        for line in blob.lines() {
            if line.contains(':') && line.contains('=') && line.contains('"') {
                if let Some(tail) = line.split_once('=') {
                    let t = tail.1.trim().trim_matches('"').trim_matches('\'');
                    if let Some((_, func)) = t.rsplit_once(':') {
                        out.insert(func.trim().to_string());
                    }
                }
            }
        }
    }
    out
}

fn pytest_active(root: &Path) -> bool {
    for name in ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"] {
        if let Ok(blob) = fs::read_to_string(root.join(name)) {
            if blob.contains("pytest") {
                return true;
            }
        }
    }
    false
}

fn analyze(
    root: &Path,
    parsed: &BTreeMap<String, FileFacts>,
    include: &str,
    skip_tests: bool,
) -> Analysis {
    let files: Vec<&String> = parsed
        .keys()
        .filter(|rel| !(skip_tests && is_test_file(rel)))
        .collect();

    let mut defs: Vec<Def> = Vec::new();
    let mut refs: HashMap<Scope, HashSet<String>> = HashMap::new();
    let mut strings: HashSet<String> = HashSet::new();
    let mut exports: HashSet<String> = HashSet::new();
    let mut reexports: HashSet<String> = HashSet::new();
    let mut escape_seeds: HashSet<String> = HashSet::new();

    for rel in &files {
        let f = &parsed[*rel];
        defs.extend(f.defs.iter().cloned());
        for (scope, names) in &f.refs {
            // A scope's references minus what it binds locally.
            let local = f.binds.get(scope).cloned().unwrap_or_default();
            refs.entry(scope.clone())
                .or_default()
                .extend(names.difference(&local).cloned());
        }
        strings.extend(f.strings.iter().cloned());
        exports.extend(f.exports.iter().cloned());
        reexports.extend(f.reexports.iter().cloned());
        escape_seeds.extend(f.escape_seeds.iter().cloned());
    }

    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, d) in defs.iter().enumerate() {
        by_name.entry(d.name.clone()).or_default().push(i);
    }

    // Escape: seeds, then two bounded hops through what escaped code hands out.
    // Only what actually leaves — expanding through arbitrary mentions swept up
    // unrelated dead code.
    let mut escaped: HashSet<String> = escape_seeds.clone();
    for _ in 0..2 {
        let mut grown: HashSet<String> = HashSet::new();
        for d in &defs {
            if !escaped.contains(&d.name) {
                continue;
            }
            let owner = Scope::Def(d.file.clone(), d.line);
            if let Some(names) = refs.get(&owner) {
                for n in names {
                    if by_name.contains_key(n) && !escaped.contains(n) {
                        grown.insert(n.clone());
                    }
                }
            }
        }
        if grown.is_empty() {
            break;
        }
        escaped.extend(grown);
    }

    let entry = entry_point_names(root);
    let testing = pytest_active(root);
    let project_classes: HashSet<&str> = defs
        .iter()
        .filter(|d| d.kind == "class")
        .map(|d| d.name.as_str())
        .collect();
    let class_at: HashMap<(String, usize), usize> = defs
        .iter()
        .enumerate()
        .filter(|(_, d)| d.kind == "class")
        .map(|(i, d)| ((d.file.clone(), d.line), i))
        .collect();

    let enclosing_class = |d: &Def| -> Option<usize> {
        if d.kind != "method" {
            return None;
        }
        match &d.parent {
            Scope::ClassBody(f, l) => class_at.get(&(f.clone(), *l)).copied(),
            _ => None,
        }
    };

    // A class answering an OUTSIDE contract takes its methods with it: otel
    // calls `on_end`, so `on_end` is live and everything it calls is too.
    let externally_bound = |d: &Def| -> bool {
        match enclosing_class(d) {
            None => false,
            Some(ci) => {
                let cls = &defs[ci];
                if escaped.contains(&cls.name) {
                    return true;
                }
                cls.bases.iter().any(|b| {
                    let r = b
                        .split('(')
                        .next()
                        .unwrap_or(b)
                        .split('[')
                        .next()
                        .unwrap_or(b)
                        .split('.')
                        .next()
                        .unwrap_or(b)
                        .trim();
                    !r.is_empty() && !project_classes.contains(r)
                })
            }
        }
    };

    let is_test_def = |d: &Def| -> bool {
        let base = d.file.rsplit('/').next().unwrap_or(&d.file);
        let looks = base.starts_with("test_") || base.ends_with("_test.py");
        if !(testing && looks) {
            return false;
        }
        d.kind == "class" || d.name.starts_with("test") || d.name.starts_with("Test")
    };

    let framework_decorated = |d: &Def| -> bool {
        d.decorators.iter().any(|(name, module)| {
            if BARE_STDLIB_DECORATORS.contains(&name.as_str()) {
                return false;
            }
            match module {
                Some(m) => !STDLIB_DECORATOR_MODULES.contains(&m.as_str()),
                None => true,
            }
        })
    };

    // Ordered like Python's Counter.most_common: count desc, first-seen order
    // for ties.
    let mut excluded_order: Vec<String> = Vec::new();
    let mut excluded_counts: HashMap<String, usize> = HashMap::new();
    let bump = |why: &str,
                    order: &mut Vec<String>,
                    counts: &mut HashMap<String, usize>| {
        if !counts.contains_key(why) {
            order.push(why.to_string());
        }
        *counts.entry(why.to_string()).or_insert(0) += 1;
    };

    let mut roots: HashSet<(String, usize, String)> = HashSet::new();
    for d in &defs {
        let n = &d.name;
        let why = if externally_bound(d) {
            Some("method answering an external contract")
        } else if n.starts_with("__") && n.ends_with("__") {
            Some("dunder / protocol method")
        } else if exports.contains(n) || entry.contains(n) {
            Some("declared public API or entry point")
        } else if reexports.contains(n) && d.kind != "method" {
            Some("re-exported by an import")
        } else if strings.contains(n) {
            Some("named in a string (dynamic reference)")
        } else if is_test_def(d) {
            Some("pytest test")
        } else if framework_decorated(d) {
            Some("framework decorator")
        } else if escaped.contains(n) {
            Some("escapes into a namespace")
        } else {
            None
        };
        if let Some(why) = why {
            bump(why, &mut excluded_order, &mut excluded_counts);
            roots.insert(d.key());
        }
    }

    // Reachability from live roots, as a worklist. Both owner kinds per symbol:
    // a class contributes references from its own body as well as its methods,
    // and queueing only the `def` key silently dropped every class-level
    // annotation, default and attribute initialiser.
    let inside = |owner: &Scope, d: &Def| -> bool {
        match owner {
            Scope::Def(f, l) | Scope::ClassBody(f, l) => {
                *f == d.file && d.line <= *l && *l <= d.end
            }
            Scope::Module(_) => false,
        }
    };

    let mut dead: HashMap<(String, usize, String), usize> = defs
        .iter()
        .enumerate()
        .filter(|(_, d)| !roots.contains(&d.key()))
        .map(|(i, d)| (d.key(), i))
        .collect();

    let mut queue: Vec<Scope> = files.iter().map(|r| Scope::Module((*r).clone())).collect();
    for d in &defs {
        if roots.contains(&d.key()) {
            queue.push(Scope::Def(d.file.clone(), d.line));
            queue.push(Scope::ClassBody(d.file.clone(), d.line));
        }
    }
    let mut seen: HashSet<Scope> = HashSet::new();
    while let Some(owner) = queue.pop() {
        if !seen.insert(owner.clone()) {
            continue;
        }
        let names: Vec<String> = match refs.get(&owner) {
            Some(s) => s.iter().cloned().collect(),
            None => continue,
        };
        for n in names {
            let idxs = match by_name.get(&n) {
                Some(v) => v.clone(),
                None => continue,
            };
            for i in idxs {
                let d = &defs[i];
                if !dead.contains_key(&d.key()) || inside(&owner, d) {
                    continue;
                }
                dead.remove(&d.key());
                queue.push(Scope::Def(d.file.clone(), d.line));
                queue.push(Scope::ClassBody(d.file.clone(), d.line));
            }
        }
    }

    // Which dead symbols reference which other dead symbols. Computed after the
    // worklist because it is only meaningful over the final dead set: a caller
    // that turned out to be live took its callees with it.
    let dead_at: HashMap<(String, usize), usize> = dead
        .values()
        .map(|&i| ((defs[i].file.clone(), defs[i].line), i))
        .collect();
    let mut callers_of: HashMap<usize, Vec<String>> = HashMap::new();
    for &i in dead.values() {
        let d = &defs[i];
        for (owner, names) in &refs {
            if !names.contains(&d.name) || inside(owner, d) {
                continue;
            }
            let pos = match owner {
                Scope::Def(f, l) | Scope::ClassBody(f, l) => Some((f.clone(), *l)),
                Scope::Module(_) => None,
            };
            if let Some(pos) = pos {
                if let Some(&j) = dead_at.get(&pos) {
                    if j != i {
                        let c = &defs[j];
                        callers_of
                            .entry(i)
                            .or_default()
                            .push(format!("{}:{}:{}", c.file, c.line, c.name));
                    }
                }
            }
        }
    }

    let method_names: HashMap<&str, usize> = {
        let mut m: HashMap<&str, usize> = HashMap::new();
        for d in defs.iter().filter(|d| d.kind == "method") {
            *m.entry(d.name.as_str()).or_insert(0) += 1;
        }
        m
    };

    let mut certain = Vec::new();
    let mut probable = Vec::new();
    let mut remaining: Vec<usize> = dead.values().copied().collect();
    remaining.sort();
    for i in remaining {
        let d = &defs[i];
        if !include.is_empty() && !d.file.starts_with(include) {
            continue;
        }
        let mut d = d.clone();
        d.ambiguous = by_name.get(&d.name).map(|v| v.len()).unwrap_or(0) > 1;
        d.dead_callers = callers_of.get(&i).cloned().unwrap_or_default();
        d.dead_callers.sort();
        d.dead_callers.dedup();
        let poly = method_names.get(d.name.as_str()).copied().unwrap_or(0) > 1;
        if d.kind == "method" && (poly || matches!(d.parent, Scope::ClassBody(_, _))) {
            probable.push(d);
        } else {
            certain.push(d);
        }
    }

    let mut excluded: Vec<(String, usize)> = excluded_order
        .into_iter()
        .map(|k| {
            let v = excluded_counts[&k];
            (k, v)
        })
        .collect();
    excluded.sort_by(|a, b| b.1.cmp(&a.1));

    Analysis {
        name_counts: by_name.iter().map(|(k, v)| (k.clone(), v.len())).collect(),
        dead: certain,
        probable,
        excluded,
        files: files.len(),
        defs: defs.len(),
    }
}

// ---------------------------------------------------------------------------
// git reasons
// ---------------------------------------------------------------------------

fn git(repo: &Path, args: &[&str]) -> String {
    std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Why a symbol is unreferenced, from history rather than resemblance.
///
/// never wired    — the name appears in exactly one commit, the one that wrote
///                  it. It never had a caller to lose.
/// lost its calls — its occurrence count changed in later commits too, so
///                  references existed and were removed.
fn reason_for(repo: &Path, d: &Def) -> (String, String, usize) {
    let word = format!("\\b{}\\b", regex::escape(&d.name));
    let born = git(
        repo,
        &["log", "--reverse", "--format=%ad", "--date=short", "--pickaxe-regex", "-S", &word, "--", &d.file],
    );
    // Word-bounded: a plain -S is a SUBSTRING search, so `Decision` matched
    // every commit touching `PolicyDecision` and the verdict flipped.
    let touched = git(
        repo,
        &["log", "--format=%ad", "--date=short", "--pickaxe-regex", "-S", &word],
    );
    let commits = touched.lines().filter(|l| !l.is_empty()).count();
    let reason = if commits <= 1 { "never wired" } else { "lost its calls" };
    let born = born.lines().next().unwrap_or("?").to_string();
    (reason.to_string(), if born.is_empty() { "?".into() } else { born }, commits)
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

pub fn run(path: &str, include: Option<&str>, show_probable: bool, reasons: bool, as_json: bool) -> Result<Value, String> {
    let root = fs::canonicalize(path).map_err(|e| format!("repo path {path:?}: {e}"))?;
    let include = include.unwrap_or("");

    // Parse every file ONCE, tests included: the analysis runs twice and the
    // two passes differ only in which files they look at.
    let mut parsed: BTreeMap<String, FileFacts> = BTreeMap::new();
    for (rel, full) in py_files(&root, false) {
        if let Ok(source) = fs::read_to_string(&full) {
            if let Some(facts) = parse_file(&rel, &source) {
                parsed.insert(rel, facts);
            }
        }
    }

    let strict = analyze(&root, &parsed, include, true);
    let with_tests = analyze(&root, &parsed, include, false);
    let unreachable_keys: HashSet<(String, usize, String)> =
        with_tests.dead.iter().map(|d| d.key()).collect();

    // Names bound as locals, and where. A load of such a name may be the local
    // rather than the def, so the finding is marked for a human to check.
    let mut bound_in: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (rel, facts) in &parsed {
        for names in facts.binds.values() {
            for n in names {
                bound_in.entry(n.as_str()).or_default().insert(rel.as_str());
            }
        }
    }
    let flag = |d: &mut Def| {
        let elsewhere = bound_in
            .get(d.name.as_str())
            .map(|files| files.iter().any(|f| *f != d.file))
            .unwrap_or(false);
        let duplicated = with_tests.name_counts.get(&d.name).copied().unwrap_or(0) > 1;
        d.ambiguous = elsewhere || duplicated;
    };

    let mut unreachable: Vec<Def> = Vec::new();
    let mut test_only: Vec<Def> = Vec::new();
    for d in &strict.dead {
        let mut d = d.clone();
        flag(&mut d);
        if unreachable_keys.contains(&d.key()) {
            unreachable.push(d);
        } else {
            test_only.push(d);
        }
    }
    let by_pos = |a: &Def, b: &Def| (a.file.clone(), a.line).cmp(&(b.file.clone(), b.line));
    unreachable.sort_by(by_pos);
    test_only.sort_by(by_pos);

    if as_json {
        let render = |rows: &[Def]| -> Vec<Value> {
            rows.iter()
                .map(|d| {
                    // `end` travels with the symbol so a reader can show the
                    // definition itself rather than a guessed window around it.
                    let mut o = json!({
                        "file": d.file, "line": d.line, "end": d.end, "kind": d.kind,
                        "name": d.name, "ambiguous": d.ambiguous,
                        "dead_callers": d.dead_callers,
                    });
                    if reasons {
                        let (reason, born, commits) = reason_for(&root, d);
                        o["reason"] = json!(reason);
                        o["born"] = json!(born);
                        o["commits"] = json!(commits);
                    }
                    o
                })
                .collect()
        };
        return Ok(json!({
            "files": strict.files,
            "definitions": strict.defs,
            "unreachable": render(&unreachable),
            "test_only": render(&test_only),
            "probable": strict.probable.len(),
        }));
    }

    println!("scanned {} files, {} definitions", strict.files, strict.defs);
    for (why, n) in &strict.excluded {
        println!("  excluded - {why}: {n}");
    }
    let show = |title: &str, note: &str, rows: &[Def]| {
        // Only the TOP of each chain is listed. A symbol reached solely from
        // another dead one is not a separate decision — it goes when its caller
        // goes — and listing it apart reads as several findings where there is one.
        let roots: Vec<&Def> = rows.iter().filter(|d| d.dead_callers.is_empty()).collect();
        let folded = rows.len() - roots.len();
        println!("
===== {title}: {} =====", roots.len());
        println!("  {note}");
        if folded > 0 {
            println!("  (+{folded} reached only from these, folded in)");
        }
        for d in roots {
            let flag = if d.ambiguous { "  [name not unique]" } else { "" };
            let deco = d
                .decorators
                .first()
                .map(|(n, _)| format!("  @{n}"))
                .unwrap_or_default();
            println!("  {}:{}  {:<8} {}{}{}", d.file, d.line, d.kind, d.name, deco, flag);
            if reasons {
                let (reason, born, commits) = reason_for(&root, d);
                println!("        {reason}, born {born}, {commits} commit(s)");
            }
        }
    };
    show(
        "UNREACHABLE - no reference anywhere, tests included",
        "nothing in the repository calls these; deleting them changes no behaviour",
        &unreachable,
    );
    show(
        "TEST-ONLY - reachable from the suite and nowhere else",
        "tested but never wired into a product path; the tests would go with them",
        &test_only,
    );
    if show_probable {
        show(
            "PROBABLE - methods that may be overrides/duck-typed",
            "",
            &strict.probable,
        );
    } else {
        println!(
            "\n(+{} methods that may be overrides — rerun with --show-probable)",
            strict.probable.len()
        );
    }
    Ok(Value::Null)
}
