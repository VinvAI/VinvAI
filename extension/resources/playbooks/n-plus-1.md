# Playbook: n-plus-1 (repeated child call inside one request)

The evidence behind this kind: within a single request, one callee fired many
times under one parent — the classic "one query for the list, one query per
row" shape. The measured collapse potential is everything past the first call.

## Fix patterns, in preference order

1. **Batch at the source.** Replace the per-item call with ONE call that takes
   the whole set: `WHERE id IN (...)`, a bulk fetch, a multi-get. This is the
   real fix — the loop disappears from the wire, not just from the code.
2. **Eager-load the relation.** If an ORM lazy-load is the driver, declare the
   join/prefetch on the originating query (`selectinload`, `joinedload`,
   `prefetch_related`) so the framework batches for you.
3. **Hoist the invariant part.** When each iteration recomputes something that
   does not depend on the item (config lookup, auth context), lift it above
   the loop.

## Traps

- **Batch size**: an unbounded `IN (...)` over 100k ids trades N+1 for one
  query the database refuses. Chunk large sets.
- **Over-fetching**: a joined eager-load can multiply rows (cartesian blowup)
  and be SLOWER than the loop. Prefer two queries (parent, then children by
  parent-id set) when relations are wide.
- **Changed ordering/nulls**: a batched fetch returns items in a different
  order and silently drops missing ids. Re-assemble results keyed by id and
  handle absent keys exactly as the per-item path did.
- **Hidden N+1 below**: batching the top call can expose the same shape one
  level down. Re-trace after the fix rather than assuming.

## Verification discipline

Re-run the same request and count the callee's invocations in the fresh trace:
it should be O(1) per request, not O(items). Responses must stay
byte/shape-identical — including ordering and missing-item behavior.
