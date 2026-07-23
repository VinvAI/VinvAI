"""Golden service: an empty cart exposes the planted division-by-zero bug."""


class _Route:
    def post(self, _path: str):
        def decorate(fn):
            return fn

        return decorate


app = _Route()


def compute_total(items: list[dict[str, float]]) -> float:
    """Return the average item price."""
    subtotal = sum(item["price"] for item in items)
    return subtotal / len(items)  # PLANTED_BUG: empty carts divide by zero.


@app.post("/checkout")
def checkout(payload: dict) -> dict:
    """Build the checkout response."""
    return {"average": compute_total(payload["items"])}
