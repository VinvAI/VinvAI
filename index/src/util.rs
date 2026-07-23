//! Small shared helpers: hex encoding, hashing, and JSON result printing.

use sha2::{Digest, Sha256};

/// Lowercase hex encoding of a byte slice (avoids pulling in the `hex` crate).
pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// SHA-256 of a byte slice, hex-encoded.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    to_hex(&hasher.finalize())
}

/// Print a JSON object to stdout on one line. Returns the value unchanged so
/// callers can chain it into an exit-code decision.
pub fn print_json(value: &serde_json::Value) {
    match serde_json::to_string(value) {
        Ok(s) => println!("{s}"),
        // Serialization of a plain object cannot realistically fail, but never
        // panic on the happy path of a CLI.
        Err(e) => println!("{{\"status\":\"error\",\"error\":\"json:{e}\"}}"),
    }
}

/// Convenience: build and print an `{"status":"error","error":..}` object.
pub fn print_error(msg: &str) {
    print_json(&serde_json::json!({ "status": "error", "error": msg }));
}
