"""Exercise both the healthy path and the planted failure."""

from planted_app.service import checkout


assert checkout({"items": [{"price": 10.0}, {"price": 20.0}]}) == {"average": 15.0}

try:
    checkout({"items": []})
except ZeroDivisionError:
    pass
else:
    raise AssertionError("the golden planted bug did not reproduce")
