//! A small BM25 lexical index. Built at index/update time from the stored
//! chunk text — cheap at code-index sizes, and it gives exact-identifier /
//! error-string matching that dense embeddings miss.
//!
//! Tokenization splits identifiers on `_` and camelCase into subword tokens, so
//! a query word like "retry" matches `retry_gateway_request` and `findById`.
//!
//! The structure supports true incremental maintenance: a changed or deleted
//! document's contributions can be subtracted (`remove_doc`), new documents
//! appended (`add_doc`), and the internal slot numbering re-aligned to a new
//! row order (`remap`). All counts are integers and the postings map is a
//! `BTreeMap`, so the serialized form is a deterministic pure function of the
//! corpus — an incrementally maintained index is byte-identical to a
//! from-scratch build over the same documents.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

const K1: f32 = 1.5;
const B: f32 = 0.75;

/// On-disk BM25 structure format. Bump whenever the serialized shape, the
/// tokenizer, or `doc_for` changes — old stores then fail the format check on
/// load and are transparently rebuilt by the next index/update (queries fall
/// back to an in-memory build until then).
///
/// v2: integer doc lengths + total (exact incremental arithmetic), sorted
/// `BTreeMap` postings keyed by `(slot, tf)` pairs sorted by slot
/// (deterministic serialization; v1's `HashMap` made bm25.json byte-unstable
/// across identical rebuilds).
pub const BM25_FORMAT: u32 = 2;

/// A BM25 lexical index over one document per chunk, slot-aligned with store
/// rows on disk (slot i == chunk row i after every save).
#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct Bm25 {
    /// Structure format (see [`BM25_FORMAT`]); validated on load.
    format: u32,
    /// Sum of all live documents' token counts (exact, for avgdl).
    total_len: u64,
    /// Token count per document slot.
    doc_len: Vec<u32>,
    /// term -> postings sorted by slot: `(doc slot, term frequency)`.
    postings: BTreeMap<String, Vec<(u32, u32)>>,
}

impl Bm25 {
    /// Build from one text blob per document (chunk), slot i == docs\[i\].
    pub fn build(docs: &[String]) -> Bm25 {
        let mut index = Bm25 {
            format: BM25_FORMAT,
            total_len: 0,
            doc_len: Vec::with_capacity(docs.len()),
            postings: BTreeMap::new(),
        };
        for doc in docs {
            index.add_doc(doc);
        }
        index
    }

    /// True when the deserialized structure is the current format. A stale
    /// format must be discarded (and rebuilt), never scored.
    pub fn is_current_format(&self) -> bool {
        self.format == BM25_FORMAT
    }

    /// Number of document slots (== store rows for an on-disk index).
    pub fn doc_count(&self) -> usize {
        self.doc_len.len()
    }

    /// BM25 score for every document against `query` (0.0 where no term
    /// matches), aligned with document slots.
    pub fn scores(&self, query: &str) -> Vec<f32> {
        let n = self.doc_len.len();
        let mut scores = vec![0.0f32; n];
        if n == 0 || self.total_len == 0 {
            return scores;
        }
        let avgdl = self.total_len as f32 / n as f32;
        let mut query_terms: Vec<String> = tokenize(query);
        query_terms.sort();
        query_terms.dedup();

        for term in query_terms {
            let postings = match self.postings.get(&term) {
                Some(p) => p,
                None => continue,
            };
            let df = postings.len() as f32;
            // BM25+ style idf, always positive.
            let idf = ((n as f32 - df + 0.5) / (df + 0.5) + 1.0).ln();
            for &(doc, freq) in postings {
                let f = freq as f32;
                let dl = self.doc_len[doc as usize] as f32;
                let denom = f + K1 * (1.0 - B + B * dl / avgdl);
                scores[doc as usize] += idf * (f * (K1 + 1.0)) / denom;
            }
        }
        scores
    }

    /// Append a new document; returns its slot (always `doc_count() - 1`).
    pub fn add_doc(&mut self, text: &str) -> usize {
        let slot = self.doc_len.len();
        let (tf, len) = term_frequencies(text);
        self.doc_len.push(len);
        self.total_len += u64::from(len);
        for (term, freq) in tf {
            // New slot is the largest index, so pushing keeps the list sorted.
            self.postings.entry(term).or_default().push((slot as u32, freq));
        }
        slot
    }

    /// Subtract a document's contributions. `text` must be the exact document
    /// text the slot was indexed with — every term count is verified against
    /// the stored postings, and any mismatch returns `Err` (the caller must
    /// discard this index and rebuild; the structure may be partially
    /// mutated). The slot's length becomes 0 and is dropped by `remap`.
    pub fn remove_doc(&mut self, slot: usize, text: &str) -> Result<(), String> {
        let (tf, len) = term_frequencies(text);
        let recorded = *self.doc_len.get(slot).ok_or_else(|| format!("no doc slot {slot}"))?;
        if recorded != len {
            return Err(format!("doc {slot}: recorded length {recorded} != tokenized {len}"));
        }
        for (term, freq) in tf {
            let list = self
                .postings
                .get_mut(&term)
                .ok_or_else(|| format!("doc {slot}: term {term:?} has no postings"))?;
            let pos = list
                .binary_search_by_key(&(slot as u32), |e| e.0)
                .map_err(|_| format!("doc {slot}: no posting for term {term:?}"))?;
            if list[pos].1 != freq {
                return Err(format!(
                    "doc {slot}: term {term:?} tf {} != tokenized {freq}",
                    list[pos].1
                ));
            }
            list.remove(pos);
            if list.is_empty() {
                self.postings.remove(&term);
            }
        }
        self.total_len -= u64::from(len);
        self.doc_len[slot] = 0;
        Ok(())
    }

    /// Renumber document slots: `new_row_of_slot[slot]` is the new row for a
    /// surviving document, `None` for a removed one (which must have been
    /// `remove_doc`ed already). The mapping must cover every row `0..new_n`
    /// exactly once. On `Err` the structure is unchanged.
    pub fn remap(&mut self, new_row_of_slot: &[Option<u32>], new_n: usize) -> Result<(), String> {
        if new_row_of_slot.len() != self.doc_len.len() {
            return Err(format!(
                "remap covers {} slots, index has {}",
                new_row_of_slot.len(),
                self.doc_len.len()
            ));
        }
        let mut doc_len = vec![0u32; new_n];
        let mut assigned = vec![false; new_n];
        for (slot, target) in new_row_of_slot.iter().enumerate() {
            match *target {
                Some(row) => {
                    let row = row as usize;
                    if row >= new_n || assigned[row] {
                        return Err(format!("slot {slot}: row {row} out of range or duplicated"));
                    }
                    assigned[row] = true;
                    doc_len[row] = self.doc_len[slot];
                }
                None if self.doc_len[slot] != 0 => {
                    return Err(format!("slot {slot} is live but unmapped"));
                }
                None => {}
            }
        }
        if let Some(row) = assigned.iter().position(|a| !a) {
            return Err(format!("row {row} has no source slot"));
        }
        if doc_len.iter().map(|&l| u64::from(l)).sum::<u64>() != self.total_len {
            return Err("remapped lengths do not sum to total_len".to_string());
        }
        for (term, list) in self.postings.iter() {
            for &(slot, _) in list {
                if new_row_of_slot[slot as usize].is_none() {
                    return Err(format!("term {term:?} still posts to removed slot {slot}"));
                }
            }
        }

        // Validated — now mutate. Postings mutate in place; lists were sorted
        // by old slot and the mapping need not be monotonic, so re-sort.
        for list in self.postings.values_mut() {
            for entry in list.iter_mut() {
                entry.0 = new_row_of_slot[entry.0 as usize].expect("validated above");
            }
            list.sort_unstable_by_key(|e| e.0);
        }
        self.doc_len = doc_len;
        Ok(())
    }
}

/// Tokenize `text` and count term frequencies; returns `(tf, token count)`.
fn term_frequencies(text: &str) -> (HashMap<String, u32>, u32) {
    let mut tf: HashMap<String, u32> = HashMap::new();
    let mut len = 0u32;
    for tok in tokenize(text) {
        *tf.entry(tok).or_insert(0) += 1;
        len += 1;
    }
    (tf, len)
}

/// The document text a chunk contributes to the BM25 index — used identically
/// at build time (pipeline) and any query-time fallback, so postings line up.
/// Learned tags (retrieval-feedback aliases) join the document so queries in
/// user vocabulary match symbols whose code never says the word.
pub fn doc_for(name: &str, summary: &str, text: &str, tags: &[String]) -> String {
    if tags.is_empty() {
        format!("{name} {summary} {text}")
    } else {
        format!("{name} {} {summary} {text}", tags.join(" "))
    }
}

/// Split text into lowercased subword tokens: break on non-alphanumerics, then
/// on camelCase / acronym / letter–digit boundaries (no regex look-around,
/// which the Rust `regex` crate doesn't support).
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in text.split(|c: char| !c.is_alphanumeric()) {
        if !part.is_empty() {
            split_subwords(part, &mut out);
        }
    }
    out
}

fn split_subwords(part: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = part.chars().collect();
    let mut start = 0usize;
    for i in 1..chars.len() {
        let prev = chars[i - 1];
        let cur = chars[i];
        let next_lower = chars.get(i + 1).map(|c| c.is_lowercase()).unwrap_or(false);
        let boundary = (prev.is_lowercase() && cur.is_uppercase())            // camelCase
            || (prev.is_uppercase() && cur.is_uppercase() && next_lower)      // HTTPServer -> HTTP|Server
            || (prev.is_ascii_digit() != cur.is_ascii_digit());              // letter<->digit
        if boundary {
            push_lower(&chars[start..i], out);
            start = i;
        }
    }
    push_lower(&chars[start..], out);
}

fn push_lower(chars: &[char], out: &mut Vec<String>) {
    if chars.is_empty() {
        return;
    }
    out.push(chars.iter().collect::<String>().to_ascii_lowercase());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_splits_identifiers_into_subwords() {
        assert_eq!(
            tokenize("retry_gatewayRequest HTTPServer v2"),
            vec!["retry", "gateway", "request", "http", "server", "v", "2"]
        );
    }

    #[test]
    fn bm25_ranks_exact_identifier_matches_first() {
        let docs = vec![
            doc_for("parse_config", "reads the config file", "def parse_config(path):", &[]),
            doc_for("send_email", "sends a message", "def send_email(to):", &[]),
            doc_for("main", "entry point", "def main(): parse_config()", &[]),
        ];
        let index = Bm25::build(&docs);
        let scores = index.scores("parse_config");
        assert!(scores[0] > scores[1], "definition should outscore unrelated doc");
        assert!(scores[0] > scores[2], "definition should outscore a caller");
        assert_eq!(scores[1], 0.0);
    }

    #[test]
    fn learned_tags_make_user_vocabulary_searchable() {
        // The code never says "authentication" — only the learned tag does.
        let tags = vec!["authentication".to_string(), "session".to_string()];
        let docs = vec![
            doc_for("check_token", "validates a bearer token", "def check_token(t):", &tags),
            doc_for("send_email", "sends a message", "def send_email(to):", &[]),
        ];
        let index = Bm25::build(&docs);
        let scores = index.scores("authentication");
        assert!(scores[0] > 0.0, "tagged chunk matches feedback vocabulary");
        assert_eq!(scores[1], 0.0);
    }

    #[test]
    fn empty_index_scores_nothing() {
        let index = Bm25::build(&[]);
        assert!(index.scores("anything").is_empty());
    }

    #[test]
    fn incremental_remove_add_remap_equals_from_scratch_build() {
        let d0 = "alpha beta gamma".to_string();
        let d1 = "beta delta_epsilon retryGateway".to_string();
        let d2 = "gamma gamma zeta".to_string();
        let mut index = Bm25::build(&[d0.clone(), d1.clone(), d2.clone()]);

        // Replace d1, delete d0, keep d2, and add a brand-new doc; the final
        // corpus row order is [d2, d1', d3].
        let d1b = "beta beta omega".to_string();
        let d3 = "kappa alpha".to_string();
        index.remove_doc(0, &d0).unwrap();
        index.remove_doc(1, &d1).unwrap();
        let s1b = index.add_doc(&d1b);
        let s3 = index.add_doc(&d3);
        let mut map = vec![None; index.doc_count()];
        map[2] = Some(0);
        map[s1b] = Some(1);
        map[s3] = Some(2);
        index.remap(&map, 3).unwrap();

        let fresh = Bm25::build(&[d2, d1b, d3]);
        assert_eq!(index, fresh, "incremental result must equal a from-scratch build");
    }

    #[test]
    fn remove_doc_rejects_wrong_text() {
        let doc = "alpha beta".to_string();
        let mut index = Bm25::build(&[doc]);
        assert!(index.remove_doc(0, "alpha beta gamma").is_err(), "length mismatch");
        let mut index = Bm25::build(&["alpha beta".to_string()]);
        assert!(index.remove_doc(0, "alpha alpha").is_err(), "tf mismatch");
    }

    #[test]
    fn remap_validates_coverage_and_live_slots() {
        let docs = vec!["alpha".to_string(), "beta".to_string()];
        let mut index = Bm25::build(&docs);
        // Live slot left unmapped.
        assert!(index.remap(&[Some(0), None], 1).is_err());
        // Duplicate target row.
        assert!(index.remap(&[Some(0), Some(0)], 2).is_err());
        // Wrong mapping length.
        assert!(index.remap(&[Some(0)], 1).is_err());
        // A failed remap leaves the index scoreable and unchanged.
        assert_eq!(index, Bm25::build(&docs));
        // Valid permutation.
        index.remap(&[Some(1), Some(0)], 2).unwrap();
        assert_eq!(index, Bm25::build(&["beta".to_string(), "alpha".to_string()]));
    }

    #[test]
    fn serialization_is_deterministic_and_format_checked() {
        let docs = vec![
            doc_for("zeta", "z", "def zeta(): beta()", &[]),
            doc_for("alpha", "a", "def alpha(): pass", &[]),
        ];
        let a = serde_json::to_vec(&Bm25::build(&docs)).unwrap();
        let b = serde_json::to_vec(&Bm25::build(&docs)).unwrap();
        assert_eq!(a, b, "identical corpora must serialize byte-identically");

        let parsed: Bm25 = serde_json::from_slice(&a).unwrap();
        assert!(parsed.is_current_format());
        // A v1-era payload (no format/total_len fields) must fail to parse.
        let legacy = br#"{"n":1,"avgdl":2.0,"doc_len":[2.0],"postings":{"a":[[0,1]]}}"#;
        assert!(serde_json::from_slice::<Bm25>(legacy).is_err());
    }
}
