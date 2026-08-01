//! The code graph: structural edges between symbols, a PageRank importance
//! prior, and neighbor / parent-context lookups for enriching query results.
//!
//! Edges are resolved heuristically by name (preferring a definition in the
//! same file). `invoke`/`inherit` edges feed PageRank — a symbol called or
//! subclassed by many others scores as more "important" (core utilities float
//! up). `contains` edges (class → member) are used only for context, not rank.

use std::collections::{HashMap, HashSet};

use crate::config;
use crate::store::{Chunk, Edge};

const DAMPING: f32 = 0.85;
const ITERATIONS: usize = 40;

/// A cross-file reference the deterministic resolver could not decide: several
/// files define `name`. These are emitted for the DSPy adjudication layer,
/// which resolves or abstains with full context — never guessed here.
pub struct PendingEdge {
    pub src: usize,
    pub name: String,
    pub candidates: Vec<usize>,
}

/// Why unresolved references were NOT published for adjudication. Reported so a
/// queue that shrinks by two thirds can say which measurement did it — a silent
/// drop reads as the index having gotten worse.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BuildStats {
    /// No candidate shares the caller's language (FFI, or a coincidental name).
    pub cross_lang: usize,
    /// Called through a receiver this repository does not define — a library
    /// call, whose only correct adjudication is abstention.
    pub external_receiver: usize,
    /// The name has more same-language definitions than `INDEX_MAX_CANDIDATES`:
    /// a generic verb of this codebase, which no adjudicator can disambiguate.
    pub generic_name: usize,
    /// Referenced through a receiver far more often than this repository
    /// defines it — a library method, whatever it happens to be called.
    pub library_method: usize,
    /// Ambiguities settled for free because exactly one candidate shared the
    /// caller's language. Not a suppression — an edge that used to be pending.
    pub resolved_by_lang: usize,
}

/// Build the edge list and the PageRank vector for a set of chunks.
/// `overrides` carries adjudicated edges (from the agent layer) that the
/// name-based resolver could not decide on its own; they participate in
/// PageRank like any other edge. Also returns the still-unresolved references.
pub fn build(
    chunks: &[Chunk],
    overrides: &[Edge],
) -> (Vec<Edge>, Vec<f32>, Vec<PendingEdge>) {
    let (edges, ranks, pending, _) = build_with_stats(chunks, overrides);
    (edges, ranks, pending)
}

/// `build`, plus the tally of references deliberately kept out of the pending
/// queue. Separate entry point so the common callers keep the plain tuple.
pub fn build_with_stats(
    chunks: &[Chunk],
    overrides: &[Edge],
) -> (Vec<Edge>, Vec<f32>, Vec<PendingEdge>, BuildStats) {
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, c) in chunks.iter().enumerate() {
        by_name.entry(c.name.as_str()).or_default().push(i);
    }

    // Every identifier this repository defines: symbol names plus file stems
    // (a module alias is spelled with its file's stem). A receiver outside this
    // set belongs to a library, which is the fact that separates
    // `user_controller.provision_user` from `JSON.parse` WITHOUT either one
    // having to appear on a list. See `is_ubiquitous` for why the list is still
    // needed one layer down, inside `resolve`.
    let owned: HashSet<&str> = by_name
        .keys()
        .copied()
        .chain(chunks.iter().map(|c| file_stem(&c.file)))
        .collect();
    let max_candidates = config::max_pending_candidates();
    let mut stats = BuildStats::default();

    let mut edges: Vec<Edge> = Vec::new();
    let mut seen: HashSet<(usize, usize, u8)> = HashSet::new();
    let mut add = |src: usize, dst: usize, kind: &str, edges: &mut Vec<Edge>| {
        if src == dst {
            return;
        }
        let tag = match kind {
            "contains" => 0u8,
            "invoke" => 1,
            _ => 2,
        };
        if seen.insert((src, dst, tag)) {
            edges.push(Edge { src, dst, kind: kind.to_string() });
        }
    };

    for e in overrides {
        if e.src < chunks.len() && e.dst < chunks.len() {
            add(e.src, e.dst, &e.kind, &mut edges);
        }
    }

    /// An unresolved reference that passed the per-call rules and is waiting on
    /// the repo-wide one.
    struct Staged {
        src: usize,
        call: String,
        bare: String,
        candidates: Vec<usize>,
        through_receiver: bool,
    }

    let mut staged: Vec<Staged> = Vec::new();
    let overridden: HashSet<(usize, &str)> = overrides
        .iter()
        .filter(|e| e.src < chunks.len() && e.dst < chunks.len())
        .map(|e| (e.src, chunks[e.dst].name.as_str()))
        .collect();

    for (i, c) in chunks.iter().enumerate() {
        if let Some(parent) = &c.parent {
            if let Some(pi) = resolve(&by_name, parent, &c.file, chunks, None) {
                add(pi, i, "contains", &mut edges);
            }
        }
        for call in &c.calls {
            // Pending and overrides are keyed on the bare name: the receiver is
            // part of the call path, not of any symbol's name.
            let (receiver_root, name, through_receiver) = split_reference(call);
            // An adjudicated edge settles this reference outright. Resolving it
            // again by name would add a *second* invoke edge whenever the
            // resolver disagrees with the adjudication, so the decision from
            // the agent layer wins and the heuristic stands down.
            if overridden.contains(&(i, name)) {
                continue;
            }
            match resolve(&by_name, call, &c.file, chunks, Some(i)) {
                Some(ti) => add(i, ti, "invoke", &mut edges),
                None => {
                    // What reaches adjudication is decided by three facts
                    // MEASURED IN THIS REPOSITORY, never by a list of names
                    // someone judged boring. A denylist ("get", "append",
                    // "format", …) suppressed ~80% of a Python/JS queue and
                    // nothing at all in a Go or Java tree, while missing
                    // `JSON.parse` — 15% of this repo's queue on its own —
                    // because `parse` never made the list.
                    let candidates = match by_name.get(name) {
                        Some(c) if c.len() > 1 => c,
                        _ => continue, // unique or unknown: nothing to adjudicate
                    };

                    // 1. Receiver ownership. `user_controller.provision_user`
                    //    names a module this repo defines; `JSON.parse`,
                    //    `subprocess.run` and `img.resize(...).save` do not.
                    //    A call through a foreign receiver is a library call
                    //    whose only correct adjudication is abstention — and it
                    //    must be judged BEFORE the language collapse below, or
                    //    `"…".format` would bind to the one project `format`.
                    if through_receiver && !owned.contains(receiver_root) {
                        stats.external_receiver += 1;
                        continue;
                    }

                    // 2. Language agreement. A caller cannot invoke a symbol in
                    //    another language without a binding layer, so a
                    //    candidate set that shares no language is a coincidence
                    //    of spelling — and one that collapses to a single
                    //    same-language definition is settled by a hard fact,
                    //    not a guess. Polyglot repos pay for this in genuine
                    //    FFI edges; a missing edge stays pending, a wrong one
                    //    poisons PageRank.
                    let lang = chunks[i].lang.as_str();
                    let same_lang: Vec<usize> =
                        candidates.iter().copied().filter(|&ci| chunks[ci].lang == lang).collect();
                    match same_lang.len() {
                        0 => {
                            stats.cross_lang += 1;
                            continue;
                        }
                        1 => {
                            stats.resolved_by_lang += 1;
                            add(i, same_lang[0], "invoke", &mut edges);
                            continue;
                        }
                        _ => {}
                    }

                    // 3. In-repo name frequency. Past the cutoff the name is a
                    //    generic verb of this codebase and does not identify a
                    //    target for anyone — resolver or adjudicator.
                    if same_lang.len() > max_candidates {
                        stats.generic_name += 1;
                        continue;
                    }

                    // Staged, not published: rule 4 below is a property of the
                    // whole repository (how often this name is called through
                    // a receiver), which is not known until every call is seen.
                    staged.push(Staged {
                        src: i,
                        call: call.clone(),
                        bare: name.to_string(),
                        candidates: same_lang,
                        through_receiver,
                    });
                }
            }
        }
        for base in &c.bases {
            if let Some(bi) = resolve(&by_name, base, &c.file, chunks, None) {
                add(i, bi, "inherit", &mut edges);
            }
        }
    }

    // 4. Library-method detection, which only the whole repository can answer.
    //
    //    `store.get(...)` and `user_controller.provision_user(...)` are
    //    indistinguishable one call at a time: both go through a receiver this
    //    repo defines, both name something defined more than once. What tells
    //    them apart is how the codebase USES the name. `get` appears at 351
    //    receiver call sites against 4 definitions; `provision_user` appears at
    //    a handful against three. A project function is not invoked through
    //    hundreds of different receivers — a container method is.
    //
    //    This is the measurement that replaces the old denylist's real work.
    //    That list caught `get`/`push`/`append` by having been told about them,
    //    and caught nothing in a Go or Java tree; this catches them because of
    //    what they do here, and works the same in any language.
    let mut receiver_refs: HashMap<&str, usize> = HashMap::new();
    for s in &staged {
        if s.through_receiver {
            *receiver_refs.entry(s.bare.as_str()).or_insert(0) += 1;
        }
    }
    let min_refs = config::library_method_refs();
    let mut pending: Vec<PendingEdge> = Vec::new();
    for s in &staged {
        if s.through_receiver {
            let refs = receiver_refs.get(s.bare.as_str()).copied().unwrap_or(0);
            // Both halves matter. The floor keeps a small repo's three-call
            // helper out of it; the ratio is what makes this a measurement
            // rather than a threshold — a name only looks like a library method
            // when it is called far more often than this repo could define it.
            if refs >= min_refs && refs > s.candidates.len() * 2 {
                stats.library_method += 1;
                continue;
            }
        }
        pending.push(PendingEdge {
            src: s.src,
            name: s.call.clone(),
            candidates: s.candidates.clone(),
        });
    }

    let rank = pagerank(chunks.len(), &edges);
    (edges, rank, pending, stats)
}

/// Resolve a reference to a defining chunk, preferring the same file.
///
/// `reference` is a callee path that may carry a receiver
/// (`binary_controller.get_binary`); only its last segment names a symbol.
/// `src` is the referring chunk, when there is one.
fn resolve(
    by_name: &HashMap<&str, Vec<usize>>,
    reference: &str,
    file: &str,
    chunks: &[Chunk],
    src: Option<usize>,
) -> Option<usize> {
    let (receiver_root, name, through_receiver) = split_reference(reference);
    let has_receiver = reference.len() > name.len();

    let mut candidates: Vec<usize> = by_name.get(name)?.clone();

    // A call through a non-self receiver is never the caller invoking itself:
    // `binary_controller.get_binary()` inside `get_binary()` targets another
    // module. Drop the same-named self-collision, or the same-file preference
    // below binds the edge back to the caller and the `src == dst` guard then
    // discards it — silently deleting the delegation edge entirely.
    if through_receiver {
        if let Some(i) = src {
            candidates.retain(|&c| c != i);
        }
    }
    if candidates.is_empty() {
        return None;
    }

    // A module-alias receiver names its defining file (`user_controller.
    // provision_user` -> `.../controllers/user_controller.py`). That is import
    // resolution by convention, not a guess, so it settles names that are
    // otherwise ambiguous across a monorepo's duplicated services.
    if through_receiver {
        if let Some(&i) = candidates
            .iter()
            .find(|&&i| file_stem(&chunks[i].file) == receiver_root)
        {
            return Some(i);
        }
    }
    // A dotted call on a ubiquitous stdlib method name may only bind close to
    // home: the same file (a method of the class defined there). It must never
    // fall through to the unique-candidate rule — `"…".format(x)` would bind to
    // whichever single project function happens to be named `format`, grafting
    // that subtree onto every f-string-averse call site in the repo. Unresolved
    // is correct: the call still appears in trees as an external leaf.
    if has_receiver && is_ubiquitous(name) {
        let same: Vec<usize> = candidates
            .iter()
            .copied()
            .filter(|&i| chunks[i].file == file)
            .collect();
        if same.len() == 1 {
            return Some(same[0]);
        }
        return None;
    }
    // Prefer a definition in the same file.
    if let Some(&i) = candidates.iter().find(|&&i| chunks[i].file == file) {
        return Some(i);
    }
    // Unambiguous cross-file name → use it. Multiple cross-file candidates are
    // ambiguous without import resolution, so they are emitted as pending for
    // the adjudication layer rather than guessed (a wrong edge is worse for
    // the graph than a missing one — but a resolved one is better than both).
    if candidates.len() == 1 {
        return Some(candidates[0]);
    }
    // Several cross-file candidates. Prefer the one sharing the longest
    // directory prefix with the caller — co-located code is the call target far
    // more often than a same-named symbol in an unrelated package, and this is
    // structural evidence rather than a coin flip. Only a *strictly* nearest
    // candidate wins: a tie (including the flat case where nothing shares a
    // directory) stays unresolved and goes to the adjudication layer.
    let mut best_depth = 0usize;
    let mut best: Option<usize> = None;
    let mut tied = false;
    for &i in &candidates {
        let depth = shared_dir_prefix(&chunks[i].file, file);
        if depth > best_depth {
            best_depth = depth;
            best = Some(i);
            tied = false;
        } else if depth == best_depth && best.is_some() {
            tied = true;
        }
    }
    if tied {
        return None;
    }
    best
}

/// Split a callee path into `(receiver_root, bare name, through_receiver)`.
///
/// `binary_controller.get_binary` -> `("binary_controller", "get_binary", true)`;
/// `walk` -> `("", "walk", false)`. A `self`/`cls`/`this` receiver is the
/// caller's own object rather than a foreign one, so it does not count as
/// going through a receiver. Shared by the resolver and the pending gate so the
/// two cannot drift apart on what "has a receiver" means.
fn split_reference(reference: &str) -> (&str, &str, bool) {
    let (receiver, name) = match reference.rsplit_once('.') {
        Some((receiver, name)) => (receiver, name),
        None => ("", reference),
    };
    let receiver_root = receiver.split('.').next().unwrap_or("");
    let through_receiver =
        !receiver.is_empty() && !matches!(receiver_root, "self" | "cls" | "this");
    (receiver_root, name, through_receiver)
}

/// Number of leading *directory* components two file paths share.
/// `a/b/x.py` vs `a/b/y.py` -> 2; `x.py` vs `y.py` -> 0.
fn shared_dir_prefix(a: &str, b: &str) -> usize {
    let a: Vec<&str> = a.split(['/', '\\']).collect();
    let b: Vec<&str> = b.split(['/', '\\']).collect();
    let limit = a.len().saturating_sub(1).min(b.len().saturating_sub(1));
    (0..limit).take_while(|&i| a[i] == b[i]).count()
}

/// Method names ubiquitous in the Python/JS standard libraries and common
/// frameworks (`session.get`, `"…".format`, `items.append`, `res.json`). A
/// receiver call on one of these is a library call until proven otherwise, so
/// it may resolve via a module-stem or same-file match but never by name
/// uniqueness alone.
///
/// SCOPE: this list governs RESOLUTION only. It no longer decides what reaches
/// the adjudication queue — `build_with_stats` measures receiver ownership,
/// language agreement and in-repo name frequency instead, which generalize to
/// languages this list has never heard of.
///
/// It cannot be replaced here by the same measurements. Receiver ownership is
/// the right test for `"…".format`, but applied to resolution it would also
/// refuse `foo.bar()` where `bar` is defined exactly once in the repo — almost
/// always the correct target. Telling those apart needs type inference on the
/// receiver, which the parser does not do. Until it does, the list stays, and
/// it is consulted only after the module-stem and same-file rules have had
/// their chance.
///
/// `_UBIQUITOUS_METHODS` in `identification/src/identification/runner.py` holds
/// the same names for its own resolver. The two are NOT mirrors and do not need
/// to be kept in sync: this one gates a name binding by uniqueness, that one
/// gates `resolve_target`. Change either on its own evidence.
fn is_ubiquitous(name: &str) -> bool {
    matches!(
        name,
        "get" | "set" | "add" | "pop" | "clear" | "copy" | "update" | "remove"
            | "format" | "append" | "extend" | "insert" | "sort" | "reverse"
            | "index" | "count" | "keys" | "values" | "items" | "split" | "rsplit"
            | "join" | "strip" | "lstrip" | "rstrip" | "lower" | "upper" | "title"
            | "replace" | "startswith" | "endswith" | "encode" | "decode" | "read"
            | "write" | "close" | "flush" | "seek" | "tell" | "open" | "exists"
            | "mkdir" | "unlink" | "rename" | "resolve" | "glob" | "stat"
            | "commit" | "rollback" | "execute" | "fetchone" | "fetchall"
            | "scalar" | "scalars" | "first" | "one" | "merge" | "refresh"
            | "delete" | "filter" | "search" | "match" | "group" | "sub"
            | "compile" | "dumps" | "loads" | "dump" | "load" | "sleep" | "now"
            | "today" | "utcnow" | "strftime" | "strptime" | "isoformat"
            | "timestamp" | "send" | "recv" | "connect" | "accept" | "bind"
            | "listen" | "json" | "text" | "push" | "shift" | "unshift" | "slice"
            | "splice" | "concat" | "includes" | "indexOf" | "forEach" | "map"
            | "find" | "next" | "min" | "max" | "sum" | "any" | "all"
    )
}

/// `a/b/user_controller.py` -> `user_controller`.
fn file_stem(path: &str) -> &str {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    file.split_once('.').map(|(stem, _)| stem).unwrap_or(file)
}

/// PageRank over the `invoke`/`inherit` edges (importance flows to the callee /
/// base). Returned normalized so the maximum is 1.0.
fn pagerank(n: usize, edges: &[Edge]) -> Vec<f32> {
    if n == 0 {
        return Vec::new();
    }
    let mut out_deg = vec![0usize; n];
    let importance_edges: Vec<&Edge> = edges.iter().filter(|e| e.kind != "contains").collect();
    for e in &importance_edges {
        out_deg[e.src] += 1;
    }

    let base = (1.0 - DAMPING) / n as f32;
    let mut pr = vec![1.0 / n as f32; n];
    for _ in 0..ITERATIONS {
        let dangling: f32 = (0..n).filter(|&i| out_deg[i] == 0).map(|i| pr[i]).sum();
        let mut next = vec![base + DAMPING * dangling / n as f32; n];
        for e in &importance_edges {
            next[e.dst] += DAMPING * pr[e.src] / out_deg[e.src] as f32;
        }
        pr = next;
    }

    let max = pr.iter().cloned().fold(0.0_f32, f32::max);
    if max > 0.0 {
        for p in &mut pr {
            *p /= max;
        }
    }
    pr
}

/// Graph context for a hit: neighbors ranked by personalized PageRank from
/// `idx`, included greedily under an estimated-token budget (and a hard cap).
/// Replaces the old "first `limit` edges in list order" selection — the most
/// structurally relevant neighbors are spent against the budget first, and
/// two-hop neighbors can surface when they matter more than a weak direct one.
pub fn neighbors(
    idx: usize,
    chunks: &[Chunk],
    edges: &[Edge],
    cap: usize,
    token_budget: usize,
) -> Vec<(usize, String)> {
    // Direct-relation labels take precedence; two-hop entries are "related".
    let mut relation: HashMap<usize, &'static str> = HashMap::new();
    let mut adjacency: HashMap<usize, Vec<usize>> = HashMap::new();
    for e in edges {
        if e.src >= chunks.len() || e.dst >= chunks.len() {
            continue;
        }
        adjacency.entry(e.src).or_default().push(e.dst);
        adjacency.entry(e.dst).or_default().push(e.src);
        if e.src == idx {
            relation.entry(e.dst).or_insert(match e.kind.as_str() {
                "invoke" => "calls",
                "inherit" => "inherits",
                "contains" => "member",
                _ => "related",
            });
        } else if e.dst == idx {
            relation.entry(e.src).or_insert(match e.kind.as_str() {
                "invoke" => "called_by",
                "inherit" => "subclassed_by",
                "contains" => "member_of",
                _ => "related",
            });
        }
    }

    // Local subgraph: nodes within the configured hop radius of idx
    // (INDEX_GRAPH_HOPS, default 2) — larger context budgets can widen it.
    let mut local: HashSet<usize> = HashSet::new();
    local.insert(idx);
    let mut frontier: Vec<usize> = vec![idx];
    for _ in 0..config::graph_hops() {
        let mut next = Vec::new();
        for &node in &frontier {
            for &n in adjacency.get(&node).map(Vec::as_slice).unwrap_or(&[]) {
                if local.insert(n) {
                    next.push(n);
                }
            }
        }
        frontier = next;
    }
    if local.len() <= 1 {
        return Vec::new();
    }

    // Personalized PageRank restricted to the local subgraph, restarting at
    // idx. 20 iterations is ample at this scale.
    let restart = 1.0 - DAMPING;
    let mut score: HashMap<usize, f32> = local.iter().map(|&i| (i, 0.0)).collect();
    score.insert(idx, 1.0);
    for _ in 0..20 {
        let mut next: HashMap<usize, f32> = local.iter().map(|&i| (i, 0.0)).collect();
        *next.get_mut(&idx).unwrap() += restart;
        for (&node, &mass) in &score {
            let neighbors_of: Vec<usize> = adjacency
                .get(&node)
                .map(|adj| adj.iter().copied().filter(|n| local.contains(n)).collect())
                .unwrap_or_default();
            if neighbors_of.is_empty() {
                *next.get_mut(&idx).unwrap() += DAMPING * mass;
            } else {
                let share = DAMPING * mass / neighbors_of.len() as f32;
                for n in neighbors_of {
                    *next.get_mut(&n).unwrap() += share;
                }
            }
        }
        score = next;
    }

    let mut ranked: Vec<(usize, f32)> = score
        .into_iter()
        .filter(|(node, _)| *node != idx)
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    // Direct callees get a reserved allocation ahead of everything else.
    // Personalized PageRank alone ranks by connectedness, so `member_of`,
    // sibling and two-hop `related` nodes — which are numerous and well
    // connected — routinely consumed every slot and emptied the call tree of
    // the actual calls. Within each group PPR order is preserved.
    let floor = config::calls_floor().min(cap);
    let mut reserved: Vec<usize> = Vec::new();
    let mut rest: Vec<usize> = Vec::new();
    for (node, _) in ranked {
        if reserved.len() < floor && relation.get(&node) == Some(&"calls") {
            reserved.push(node);
        } else {
            rest.push(node);
        }
    }

    let mut out: Vec<(usize, String)> = Vec::new();
    let mut spent = 0usize;
    for node in reserved.into_iter().chain(rest) {
        if out.len() >= cap {
            break;
        }
        let c = &chunks[node];
        let rel = relation.get(&node).copied().unwrap_or("related");
        // Estimated tokens for the JSON entry: content chars / 4 plus overhead.
        let cost = (c.name.len() + c.kind.len() + c.file.len() + rel.len()) / 4 + 8;
        if spent + cost > token_budget && !out.is_empty() {
            break;
        }
        spent += cost;
        out.push((node, rel.to_string()));
    }
    out
}

/// The enclosing container and sibling members of `idx` (parent context).
/// Siblings are ranked by PageRank, not edge-list order, so the `limit` keeps
/// the most important members instead of whichever happened to parse first.
pub fn parent_context(idx: usize, chunks: &[Chunk], edges: &[Edge], limit: usize) -> Vec<usize> {
    // Parent = source of a `contains` edge into idx.
    let parent = edges
        .iter()
        .find(|e| e.kind == "contains" && e.dst == idx)
        .map(|e| e.src);
    let mut out = Vec::new();
    if let Some(p) = parent {
        out.push(p);
        let mut siblings: Vec<usize> = edges
            .iter()
            .filter(|e| e.kind == "contains" && e.src == p && e.dst != idx && e.dst < chunks.len())
            .map(|e| e.dst)
            .collect();
        siblings.sort_by(|&a, &b| {
            chunks[b]
                .rank
                .partial_cmp(&chunks[a].rank)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.cmp(&b))
        });
        siblings.truncate(limit.saturating_sub(1));
        out.extend(siblings);
    }
    out.retain(|&i| i < chunks.len());
    out
}

/// Chunk indices adjacent (any edge, any direction) to any of `seed` — used for
/// `--context-symbols` structural boosting.
pub fn adjacent_to(seed: &HashSet<usize>, edges: &[Edge]) -> HashSet<usize> {
    let mut out = HashSet::new();
    for e in edges {
        if seed.contains(&e.src) {
            out.insert(e.dst);
        }
        if seed.contains(&e.dst) {
            out.insert(e.src);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(name: &str, file: &str, parent: Option<&str>, calls: &[&str]) -> Chunk {
        Chunk {
            id: format!("{file}:{name}"),
            file: file.to_string(),
            lang: "python".to_string(),
            kind: "function".to_string(),
            name: name.to_string(),
            start_line: 1,
            end_line: 2,
            sha: String::new(),
            summary: String::new(),
            text: String::new(),
            parent: parent.map(str::to_string),
            calls: calls.iter().map(|s| s.to_string()).collect(),
            bases: Vec::new(),
            tags: Vec::new(),
            rank: 0.0,
            summary_pending: false,
            epoch: 0,
        }
    }

    #[test]
    fn build_links_calls_and_ranks_the_popular_callee_highest() {
        let chunks = vec![
            chunk("util", "lib.py", None, &[]),
            chunk("a", "a.py", None, &["util"]),
            chunk("b", "b.py", None, &["util"]),
            chunk("c", "c.py", None, &["util"]),
        ];
        let (edges, ranks, pending) = build(&chunks, &[]);
        assert_eq!(edges.iter().filter(|e| e.kind == "invoke").count(), 3);
        assert!(pending.is_empty());
        let max = ranks.iter().cloned().fold(0.0f32, f32::max);
        assert_eq!(ranks[0], max, "the callee everyone invokes must rank highest");
    }

    #[test]
    fn ambiguous_cross_file_names_become_pending_not_guessed() {
        let chunks = vec![
            chunk("dup", "x.py", None, &[]),
            chunk("dup", "y.py", None, &[]),
            chunk("caller", "z.py", None, &["dup"]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        assert!(
            edges.iter().all(|e| e.kind != "invoke"),
            "two cross-file candidates must not guess an edge"
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].src, 2);
        assert_eq!(pending[0].name, "dup");
        assert_eq!(pending[0].candidates, vec![0, 1]);
    }

    #[test]
    fn delegation_to_a_same_named_function_in_another_module_is_an_edge() {
        // The FastAPI shape: `get_binary()` in routes/ delegates to the
        // same-named `get_binary()` in controllers/. The receiver is what makes
        // this delegation rather than recursion, so the edge must survive.
        let chunks = vec![
            chunk("get_binary", "routes/binaries.py", None, &["binary_controller.get_binary"]),
            chunk("get_binary", "controllers/binary_controller.py", None, &[]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        assert!(
            edges.iter().any(|e| e.kind == "invoke" && e.src == 0 && e.dst == 1),
            "route -> controller delegation must resolve across the name collision, got {:?}",
            edges.iter().map(|e| (e.src, e.dst, &e.kind)).collect::<Vec<_>>(),
        );
        assert!(pending.is_empty(), "the receiver settles it; nothing to adjudicate");
    }

    #[test]
    fn bare_and_self_recursion_stay_self_loops_and_are_dropped() {
        let chunks = vec![
            chunk("walk", "a.py", None, &["walk", "self.walk"]),
            chunk("walk", "other/walk.py", None, &[]),
        ];
        let (edges, _, _) = build(&chunks, &[]);
        assert!(
            !edges.iter().any(|e| e.kind == "invoke"),
            "recursion must not become an edge to a same-named foreign symbol",
        );
    }

    #[test]
    fn a_ubiquitous_method_name_never_binds_by_uniqueness_alone() {
        // `record.format(...)` must not bind to the one project function named
        // `format` — but `logging.format(...)` (module-stem match) must.
        let chunks = vec![
            chunk("caller", "routes.py", None, &["record.format", "logging.format"]),
            chunk("format", "common/logging.py", None, &[]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        let invokes: Vec<(usize, usize)> = edges
            .iter()
            .filter(|e| e.kind == "invoke")
            .map(|e| (e.src, e.dst))
            .collect();
        assert_eq!(
            invokes,
            vec![(0, 1)],
            "exactly the module-stem call resolves; the untyped receiver stays external",
        );
        assert!(pending.is_empty(), "one candidate is not an ambiguity");
    }

    #[test]
    fn a_module_alias_receiver_settles_an_otherwise_ambiguous_name() {
        // `provision_user` exists three times; the receiver names its module.
        let chunks = vec![
            chunk("caller", "admin/routes/auth.py", None, &["user_controller.provision_user"]),
            chunk("provision_user", "admin/routes/users.py", None, &[]),
            chunk("provision_user", "admin/controllers/user_controller.py", None, &[]),
            chunk("provision_user", "payment/admin_client.py", None, &[]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        assert!(
            edges.iter().any(|e| e.kind == "invoke" && e.src == 0 && e.dst == 2),
            "the receiver names the defining module — resolve to it, not to a guess",
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn unresolved_ubiquitous_receiver_calls_are_not_queued_for_adjudication() {
        // Two project functions named `get` in other files; `cfg.get(...)` is a
        // library-ish call the resolver refuses to bind. It must stay an
        // external leaf — NOT become a pending edge for the LLM adjudicator.
        let chunks = vec![
            chunk("caller", "app/main.py", None, &["cfg.get"]),
            chunk("get", "store/kv.py", None, &[]),
            chunk("get", "cache/lru.py", None, &[]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        assert!(edges.iter().all(|e| e.kind != "invoke"), "must not guess an edge");
        assert!(
            pending.is_empty(),
            "deliberately-unresolved stdlib method calls must not reach adjudication",
        );

        // A BARE ubiquitous name (no receiver) keeps the normal pending path:
        // a project-local `resolve()` helper is a real candidate set.
        let bare = vec![
            chunk("caller", "app/main.py", None, &["resolve"]),
            chunk("resolve", "a/x.py", None, &[]),
            chunk("resolve", "b/y.py", None, &[]),
        ];
        let (_, _, pending) = build(&bare, &[]);
        assert_eq!(pending.len(), 1, "bare ambiguous names still go to adjudication");
    }

    // ---- the pending gate: measurements, not a list of names ----------------
    //
    // Every case below uses a method name that is NOT in `is_ubiquitous`. That
    // is the point: the old gate suppressed only names someone had listed, so
    // `JSON.parse` alone was 15% of this repo's adjudication queue.

    fn chunk_in(lang: &str, name: &str, file: &str, calls: &[&str]) -> Chunk {
        Chunk { lang: lang.to_string(), ..chunk(name, file, None, calls) }
    }

    #[test]
    fn a_receiver_this_repo_does_not_define_is_a_library_call() {
        // `JSON` is not a symbol here and names no file: `JSON.parse` is the
        // standard library, however many project functions are called `parse`.
        let chunks = vec![
            chunk("caller", "app/main.js", None, &["JSON.parse"]),
            chunk("parse", "a/args.js", None, &[]),
            chunk("parse", "b/query.js", None, &[]),
        ];
        let (edges, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert!(edges.iter().all(|e| e.kind != "invoke"), "must not guess an edge");
        assert!(pending.is_empty(), "a library call must never reach adjudication");
        assert_eq!(stats.external_receiver, 1);
    }

    #[test]
    fn a_receiver_this_repo_does_define_still_reaches_adjudication() {
        // `engine` IS a symbol here, so `engine.parse` is a project call whose
        // target is genuinely ambiguous — exactly what adjudication is for.
        let chunks = vec![
            chunk("caller", "app/main.js", None, &["engine.parse"]),
            chunk("engine", "core/engine_obj.js", None, &[]),
            chunk("parse", "a/args.js", None, &[]),
            chunk("parse", "b/query.js", None, &[]),
        ];
        let (_, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert_eq!(pending.len(), 1, "an owned receiver is not a library call");
        assert_eq!(stats.external_receiver, 0);
    }

    #[test]
    fn candidates_in_another_language_are_a_spelling_coincidence() {
        let chunks = vec![
            chunk_in("python", "caller", "svc/app.py", &["render_row"]),
            chunk_in("rust", "render_row", "index/src/fmt.rs", &[]),
            chunk_in("rust", "render_row", "index/src/view.rs", &[]),
        ];
        let (edges, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert!(edges.iter().all(|e| e.kind != "invoke"));
        assert!(pending.is_empty(), "no candidate shares the caller's language");
        assert_eq!(stats.cross_lang, 1);
    }

    #[test]
    fn one_same_language_candidate_settles_it_without_an_adjudicator() {
        // The ambiguity is only across languages; within Python there is
        // exactly one definition, which is a fact rather than a guess.
        let chunks = vec![
            chunk_in("python", "caller", "svc/app.py", &["render_row"]),
            chunk_in("rust", "render_row", "index/src/fmt.rs", &[]),
            // Deliberately NOT under svc/: a shared directory prefix would let
            // the nearest-candidate rule resolve it before the gate is reached,
            // and this test is about the language collapse doing the work.
            chunk_in("python", "render_row", "web/render.py", &[]),
        ];
        let (edges, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert!(
            edges.iter().any(|e| e.kind == "invoke" && e.src == 0 && e.dst == 2),
            "the one same-language definition is the target",
        );
        assert!(pending.is_empty());
        assert_eq!(stats.resolved_by_lang, 1);
    }

    #[test]
    fn a_name_defined_everywhere_is_generic_rather_than_ambiguous() {
        // Nine definitions of `save` in one language: past the cutoff the name
        // does not identify a target for the resolver OR an adjudicator.
        let mut chunks = vec![chunk("caller", "app/main.py", None, &["save"])];
        for i in 0..9 {
            chunks.push(chunk("save", &format!("svc{i}/model.py"), None, &[]));
        }
        let (_, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert!(pending.is_empty(), "9 candidates exceeds INDEX_MAX_CANDIDATES (8)");
        assert_eq!(stats.generic_name, 1);

        // Just inside the cutoff it is still a real ambiguity.
        let mut fewer = vec![chunk("caller", "app/main.py", None, &["save"])];
        for i in 0..8 {
            fewer.push(chunk("save", &format!("svc{i}/model.py"), None, &[]));
        }
        let (_, _, pending, stats) = build_with_stats(&fewer, &[]);
        assert_eq!(pending.len(), 1);
        assert_eq!(stats.generic_name, 0);
    }

    #[test]
    fn suppression_works_in_languages_the_old_list_never_covered() {
        // Go: `Close` (capitalized) is absent from `is_ubiquitous`, which only
        // ever knew lowercase Python/JS spellings. Ownership does not care.
        let go = vec![
            chunk_in("go", "Handle", "srv/handler.go", &["w.Close"]),
            chunk_in("go", "Close", "io/writer.go", &[]),
            chunk_in("go", "Close", "net/conn.go", &[]),
        ];
        let (_, _, pending, stats) = build_with_stats(&go, &[]);
        assert!(pending.is_empty(), "`w` is not defined here — library call");
        assert_eq!(stats.external_receiver, 1);

        // Java: same story for `toString`.
        let java = vec![
            chunk_in("java", "render", "app/Render.java", &["sb.toString"]),
            chunk_in("java", "toString", "model/User.java", &[]),
            chunk_in("java", "toString", "model/Order.java", &[]),
        ];
        let (_, _, pending, stats) = build_with_stats(&java, &[]);
        assert!(pending.is_empty());
        assert_eq!(stats.external_receiver, 1);
    }

    #[test]
    fn a_name_called_through_many_receivers_is_a_library_method() {
        // `get` reached 351 receiver call sites against 4 definitions on this
        // repository — a container method, not a project symbol. No list says
        // so; the codebase's own usage does, which is what makes this work in
        // languages the old denylist never covered.
        let mut chunks = vec![
            chunk("get", "store/kv.py", None, &[]),
            chunk("get", "cache/lru.py", None, &[]),
            chunk("holder", "app/holder.py", None, &[]),
        ];
        for i in 0..30 {
            chunks.push(chunk(&format!("caller{i}"), &format!("app/m{i}.py"), None, &["holder.get"]));
        }
        let (_, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert!(pending.is_empty(), "30 receiver call sites, 2 definitions");
        assert_eq!(stats.library_method, 30);
    }

    #[test]
    fn a_project_helper_called_a_few_times_is_still_adjudicated() {
        // The same shape below the floor: a handful of call sites through an
        // owned receiver is exactly what adjudication exists to settle.
        let mut chunks = vec![
            chunk("provision_user", "admin/a.py", None, &[]),
            chunk("provision_user", "payment/b.py", None, &[]),
            chunk("holder", "app/holder.py", None, &[]),
        ];
        for i in 0..3 {
            chunks.push(chunk(
                &format!("caller{i}"),
                &format!("app/m{i}.py"),
                None,
                &["holder.provision_user"],
            ));
        }
        let (_, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert_eq!(pending.len(), 3);
        assert_eq!(stats.library_method, 0);
    }

    #[test]
    fn a_self_call_is_not_a_foreign_receiver() {
        // `self`/`cls`/`this` are the caller's own object: the ownership rule
        // must not fire on them, or every method call in an OO codebase would
        // be classified as a library call.
        let chunks = vec![
            chunk("caller", "a/svc.py", Some("Svc"), &["self.render_row"]),
            chunk("render_row", "b/one.py", None, &[]),
            chunk("render_row", "c/two.py", None, &[]),
        ];
        let (_, _, pending, stats) = build_with_stats(&chunks, &[]);
        assert_eq!(pending.len(), 1, "a self-call stays a normal ambiguity");
        assert_eq!(stats.external_receiver, 0);
    }

    #[test]
    fn adjudicated_overrides_resolve_pending_edges_and_feed_pagerank() {
        let chunks = vec![
            chunk("dup", "x.py", None, &[]),
            chunk("dup", "y.py", None, &[]),
            chunk("caller", "z.py", None, &["dup"]),
        ];
        let overrides = vec![Edge { src: 2, dst: 0, kind: "invoke".to_string() }];
        let (edges, ranks, pending) = build(&chunks, &overrides);
        assert!(edges.iter().any(|e| e.kind == "invoke" && e.src == 2 && e.dst == 0));
        assert!(pending.is_empty(), "an override settles the ambiguity");
        assert!(ranks[0] > ranks[1], "the adjudicated callee gains importance");
    }

    #[test]
    fn neighbors_rank_by_personalized_pagerank_under_a_token_budget() {
        // hub calls a, b; a calls leaf. From hub, direct neighbors must come
        // before the two-hop leaf, and a tiny budget must cut the list.
        let chunks = vec![
            chunk("hub", "m.py", None, &["a", "b"]),
            chunk("a", "m.py", None, &["leaf"]),
            chunk("b", "m.py", None, &[]),
            chunk("leaf", "m.py", None, &[]),
        ];
        let (edges, _, _) = build(&chunks, &[]);
        let all = neighbors(0, &chunks, &edges, 16, 10_000);
        assert!(all.len() >= 3, "two-hop leaf should be reachable, got {all:?}");
        let positions: Vec<usize> = [1usize, 3]
            .iter()
            .map(|target| all.iter().position(|(n, _)| n == target).unwrap())
            .collect();
        assert!(positions[0] < positions[1], "direct neighbor before two-hop");
        assert_eq!(
            all.iter().find(|(n, _)| *n == 1).map(|(_, r)| r.as_str()),
            Some("calls")
        );
        assert_eq!(
            all.iter().find(|(n, _)| *n == 3).map(|(_, r)| r.as_str()),
            Some("related")
        );
        // The budget is respected: with ~20 estimated tokens per entry, a
        // 30-token budget admits at most two entries.
        let tight = neighbors(0, &chunks, &edges, 16, 30);
        assert!(tight.len() < all.len());
        assert!(!tight.is_empty(), "the best neighbor is always included");
    }

    #[test]
    fn the_nearest_candidate_by_directory_wins_but_a_tie_stays_pending() {
        // `helpers` exists in two packages; the caller lives in one of them.
        let chunks = vec![
            chunk("caller", "billing/routes/pay.py", None, &["helpers"]),
            chunk("helpers", "billing/routes/util.py", None, &[]),
            chunk("helpers", "auth/util.py", None, &[]),
        ];
        let (edges, _, pending) = build(&chunks, &[]);
        assert!(
            edges.iter().any(|e| e.kind == "invoke" && e.src == 0 && e.dst == 1),
            "the co-located definition is the call target, got {:?}",
            edges.iter().map(|e| (e.src, e.dst, &e.kind)).collect::<Vec<_>>(),
        );
        assert!(pending.is_empty(), "proximity settled it");

        // Equidistant candidates are still a coin flip — do not guess.
        let flat = vec![
            chunk("caller", "a/one.py", None, &["helpers"]),
            chunk("helpers", "b/util.py", None, &[]),
            chunk("helpers", "c/util.py", None, &[]),
        ];
        let (edges, _, pending) = build(&flat, &[]);
        assert!(edges.iter().all(|e| e.kind != "invoke"), "a tie must not resolve");
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn an_adjudicated_edge_overrides_the_proximity_heuristic_rather_than_doubling_it() {
        // Proximity alone would bind caller -> billing/routes/util.py (index 1).
        // The agent adjudicated it to auth/util.py (index 2); that must be the
        // only invoke edge, not an extra one alongside the heuristic's guess.
        let chunks = vec![
            chunk("caller", "billing/routes/pay.py", None, &["helpers"]),
            chunk("helpers", "billing/routes/util.py", None, &[]),
            chunk("helpers", "auth/util.py", None, &[]),
        ];
        let overrides = vec![Edge { src: 0, dst: 2, kind: "invoke".to_string() }];
        let (edges, _, pending) = build(&chunks, &overrides);
        let invokes: Vec<(usize, usize)> = edges
            .iter()
            .filter(|e| e.kind == "invoke")
            .map(|e| (e.src, e.dst))
            .collect();
        assert_eq!(invokes, vec![(0, 2)], "the adjudicated edge is the only one");
        assert!(pending.is_empty());
    }

    #[test]
    fn direct_callees_keep_reserved_slots_against_better_connected_neighbors() {
        // `caller` is a member of a large class whose siblings are densely
        // linked; its one callee must still survive into the neighbor list.
        let mut chunks = vec![
            chunk("caller", "m.py", Some("Big"), &["callee"]),
            chunk("callee", "far/away.py", None, &[]),
            chunk("Big", "m.py", None, &[]),
        ];
        for i in 0..8 {
            let name = format!("sib{i}");
            let mut c = chunk(&name, "m.py", Some("Big"), &["sib0", "sib1", "sib2"]);
            c.id = format!("m.py:{name}");
            chunks.push(c);
        }
        let (edges, _, _) = build(&chunks, &[]);
        let out = neighbors(0, &chunks, &edges, 4, 10_000);
        assert!(
            out.iter().any(|(n, rel)| *n == 1 && rel == "calls"),
            "the direct callee must hold a reserved slot, got {out:?}",
        );
    }

    #[test]
    fn continuation_chunks_link_to_their_primary_via_contains() {
        let chunks = vec![
            chunk("big", "m.py", None, &["helper"]),
            {
                let mut c = chunk("big", "m.py", Some("big"), &[]);
                c.start_line = 30;
                c.end_line = 60;
                c
            },
            chunk("helper", "m.py", None, &[]),
        ];
        let (edges, _, _) = build(&chunks, &[]);
        assert!(
            edges
                .iter()
                .any(|e| e.kind == "contains" && e.src == 0 && e.dst == 1),
            "primary chunk must contain its continuation"
        );
    }
}
