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
```

Requires [uv](https://docs.astral.sh/uv/getting-started/installation/). Already have the monorepo checked out? Vinv finds it automatically — nothing to install. You can also point Vinv at any checkout with the `vinv.enginesPath` setting.
