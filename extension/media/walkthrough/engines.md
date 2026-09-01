# Install the engines

Vinv's engines are open source and run entirely on your machine:

- **tracelens** — records what your code actually does when it runs, with no code changes
- **index** — a searchable map of every function in your project
- **vinv-embedder** — a local model for code search (no cloud keys)
- plus the analysis tools that write the handbook and set up your services

One click runs, in a visible terminal:

```
git clone <vinv monorepo> ~/.vinv/engines
cd ~/.vinv/engines && uv sync
cargo build --release --manifest-path index/Cargo.toml
```

Needs [uv](https://docs.astral.sh/uv/getting-started/installation/), [Rust](https://rustup.rs) and git. Whichever of uv and Rust is missing installs first, in the same terminal — you do not have to run anything yourself or click Install again.

Budget about 3 minutes, most of it compiling the Rust index. Code search also fetches a one-time ~100 MB embedding model the first time you use it.

Already have the monorepo checked out? Vinv finds it automatically — nothing to clone. You can also point Vinv at any checkout with the `vinv.enginesPath` setting.
