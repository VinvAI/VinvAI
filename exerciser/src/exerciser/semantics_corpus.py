"""Differential-testing corpus of Python semantic edge cases.

Purpose
-------
Compare a Python re-implementation (an AST-walking sandbox such as smolagents'
``LocalPythonExecutor``, or RustPython / Skulpt / Brython / PyPy) against CPython
by evaluating each snippet in both and comparing the value of ``result``.

Every snippet is:
  * self-contained, import-free, no I/O, no network
  * deterministic (no ``set``/``hash`` iteration order, no ``id()``, no time,
    no randomness, no GC/refcount observation)
  * fast (no loop runs more than a few dozen iterations)
  * terminated by a bare ``result`` expression, so a "value of the last
    expression" evaluator and an ``exec`` + namespace-lookup evaluator agree on
    what is being compared.

Two corpora
-----------
``SEMANTIC_CORPUS``  -- CPython runs these to completion and binds ``result``.
                        These are the *wrong-code* oracle: a buggy interpreter
                        returns a plausible but different value and no exception
                        ever fires. Weight these heavily.
``RAISING_CORPUS``   -- CPython raises. Lower value (an exception-based oracle
                        catches them), but they pin down *which* exception and
                        catch re-implementations that silently succeed.

``IMPLEMENTATION_DEFINED`` is a separate, OPT-IN tuple (not part of
``SEMANTIC_CORPUS``) whose snippets run cleanly and bind ``result`` but whose
answers are CPython implementation details -- small-int and string interning,
identity of literals, NaN identity. Concatenate it onto ``SEMANTIC_CORPUS``
when the target sandbox is hosted ON CPython (smolagents' AST walker,
RestrictedPython, asteval); leave it out when the target is RustPython, PyPy,
Brython or Jython, which are permitted to differ.

``EXCLUDED_UNSAFE`` documents cases deliberately *left out* because they are
non-deterministic, environment-dependent, or explicitly implementation-defined,
and would otherwise produce flaky diffs.

Method notes (see MODULE DOCSTRING "References" below)
------------------------------------------------------
The corpus is a hand-written *seed* set in the sense of the compiler-testing
literature. Each seed is meant to be amplified:
  * Csmith (Yang/Chen/Eide/Regehr, PLDI 2011) -- generate only from a grammar
    closed under determinism, so any divergence is an interpreter bug, never a
    program bug. That constraint is what the "no set order / no id() / no time"
    hygiene rules above encode.
  * EMI / Orion (Le/Afshari/Su, PLDI 2014), Athena (OOPSLA 2015), Hermes
    (OOPSLA 2016) -- profile a seed, then mutate never-executed code (Orion),
    MCMC-guide the insert/delete steps (Athena), or inject value-neutral *live*
    code (Hermes). Each seed here yields an unbounded family whose ``result``
    must stay identical.
  * GLFuzz (Donaldson et al., OOPSLA 2017) -- metamorphic transformation:
    wrap subexpressions in runtime-opaque identities the interpreter cannot
    constant-fold, so one seed becomes a family with a built-in oracle.
  * C-Reduce (PLDI 2012) / HDD (ICSE 2006) / Perses (ICSE 2018) -- reduce a
    failing snippet over the *AST*, not over lines, with an interestingness
    predicate of "divergence AND still deterministic AND still terminates".
  * Swarm testing (Groce et al., ISSTA 2012) -- sample a random feature subset
    per generation batch rather than enabling every construct at once.
  * PyRTFuzz (CCS 2023) and Liu et al., "Towards Understanding Bugs in Python
    Interpreters" (EMSE 2023) -- empirically, most Python-interpreter bugs
    surface as "unexpected behaviour" (wrong value), not crashes, and most
    triggering programs are under ten lines. That is exactly this shape.

The crash-bug / wrong-code-bug distinction from that literature is why
``SEMANTIC_CORPUS`` is roughly four times the size of ``RAISING_CORPUS``.

References
----------
Language Reference (docs.python.org/3/reference/, 3.14 section numbering):
  execution model 4.2.x, expressions 6.x, simple statements 7.2.x,
  compound statements 8.x, data model 3.3.x, lexical analysis 2.5.x.
CPython test suite: Lib/test/test_scope.py, test_augassign.py,
  test_listcomps.py, test_unpack_ex.py, test_patma.py, test_generators.py,
  test_contextlib.py, test_exception_group.py.
Divergence sources: doc.pypy.org/en/latest/cpython_differences.html;
  RustPython, Skulpt, Brython and huggingface/smolagents issue trackers.

Version: written for CPython 3.11+ (uses ``match``, ``except*``, exception
groups). Snippets needing 3.12+/3.13+ are marked ``[3.12+]`` etc. in comments.
"""

SEMANTIC_CORPUS: tuple[str, ...] = (
    # ------------------------------------------------------------------
    # 1. LOOP `else` CLAUSES  -- ref 8.2/8.3.
    # smolagents LocalPythonExecutor drops `orelse` entirely: silent wrong
    # answer, no exception. Highest-value class in this whole file.
    # ------------------------------------------------------------------
    # for-else runs on normal exhaustion (ref 8.3)
    """
r = []
for i in range(3):
    r.append(i)
else:
    r.append('else')
result = r
result
""",
    # for-else is SKIPPED after break (ref 8.3)
    """
r = []
for i in range(5):
    if i == 2:
        break
    r.append(i)
else:
    r.append('else')
result = r
result
""",
    # for-else runs when the iterable is empty (the loop body never ran)
    """
r = []
for i in []:
    r.append(i)
else:
    r.append('else')
result = r
result
""",
    # while-else runs on normal (condition-false) exit (ref 8.2)
    """
n = 0
r = []
while n < 3:
    r.append(n)
    n += 1
else:
    r.append('else')
result = r
result
""",
    # while-else skipped by break
    """
n = 0
r = []
while True:
    r.append(n)
    n += 1
    if n == 2:
        break
else:
    r.append('else')
result = r
result
""",
    # `continue` does not suppress the else clause
    """
r = []
for i in range(4):
    if i % 2:
        continue
    r.append(i)
else:
    r.append('else')
result = r
result
""",
    # break only skips the *innermost* else
    """
r = []
for i in range(2):
    for j in range(3):
        if j == 1:
            break
        r.append((i, j))
    else:
        r.append('inner-else')
else:
    r.append('outer-else')
result = r
result
""",
    # else on a loop inside a function, combined with return-after
    """
def find(xs, t):
    for x in xs:
        if x == t:
            return 'found'
    else:
        return 'exhausted'
result = (find([1, 2], 2), find([1, 2], 9))
result
""",
    # ------------------------------------------------------------------
    # 2. LOOP TARGET LIFETIME  -- ref 8.3.
    # ------------------------------------------------------------------
    # the loop variable is NOT deleted after the loop and keeps its last value
    """
for i in range(3):
    pass
result = i
result
""",
    # after break the loop variable holds the value at the break
    """
for i in range(10):
    if i == 4:
        break
result = i
result
""",
    # rebinding the target inside the body does not affect iteration (ref 8.3)
    """
r = []
for i in range(4):
    r.append(i)
    i = 100
result = r
result
""",
    # mutating the list being iterated: the iterator is index-based
    # (Skulpt #749 got a count of 4 here instead of 2)
    """
L = ['a', 'b', 'c', 'd']
count = 0
for c in L:
    L.pop()
    count += 1
result = (count, L)
result
""",
    # iterating a list while appending to a *copy* leaves the original intact
    """
L = [1, 2, 3]
out = []
for x in L[:]:
    L.append(x * 10)
    out.append(x)
result = (out, L)
result
""",
    # ------------------------------------------------------------------
    # 3. try / except / else / finally  -- ref 8.4.x.
    # smolagents routes its internal ReturnException through `except
    # Exception`, so `return` inside `try` picks the handler's value (#1688).
    # ------------------------------------------------------------------
    # `return` in `finally` overrides the `return` in `try` (ref 8.4.4)
    # [3.14 emits SyntaxWarning per PEP 765 -- still legal, still returns
    # 'finally']
    """
def f():
    try:
        return 'try'
    finally:
        return 'finally'
result = f()
result
""",
    # `return` in `finally` DISCARDS a pending exception (ref 8.4.4)
    """
def f():
    try:
        raise ValueError('boom')
    finally:
        return 42
result = f()
result
""",
    # the return *expression* is evaluated before `finally` runs, so a later
    # mutation in `finally` cannot change the returned value (ref 8.4.4)
    """
def f():
    x = [1]
    try:
        return x[0]
    finally:
        x[0] = 99
result = f()
result
""",
    # ...but returning the container itself DOES expose the mutation
    """
def f():
    x = [1]
    try:
        return x
    finally:
        x[0] = 99
result = f()
result
""",
    # `break` in `finally` swallows the exception (ref 8.4.4)
    """
r = []
for i in range(3):
    try:
        raise ValueError(i)
    finally:
        r.append(i)
        break
result = r
result
""",
    # try-else runs only when the try suite completed with no exception
    # (ref 8.4.3)
    """
r = []
try:
    r.append('try')
except Exception:
    r.append('except')
else:
    r.append('else')
finally:
    r.append('finally')
result = r
result
""",
    # try-else is skipped when an exception was handled
    """
r = []
try:
    raise KeyError('k')
except KeyError:
    r.append('except')
else:
    r.append('else')
finally:
    r.append('finally')
result = r
result
""",
    # an exception raised in `else` is NOT caught by the preceding except
    # (ref 8.4.3)
    """
r = []
try:
    try:
        pass
    except ValueError:
        r.append('inner-except')
    else:
        raise ValueError('from-else')
except ValueError:
    r.append('outer-except')
result = r
result
""",
    # try-else does NOT run when the try suite exits via return
    """
def f(log):
    try:
        return 'ret'
    except Exception:
        log.append('except')
    else:
        log.append('else')
    finally:
        log.append('finally')
log = []
v = f(log)
result = (v, log)
result
""",
    # first matching except clause wins, even if a later one is more specific
    """
try:
    raise KeyError('k')
except LookupError:
    result = 'LookupError'
except KeyError:
    result = 'KeyError'
result
""",
    # nested finally ordering is innermost-first
    """
r = []
def f():
    try:
        try:
            return 'inner'
        finally:
            r.append('inner-finally')
    finally:
        r.append('outer-finally')
v = f()
result = (v, r)
result
""",
    # finally runs on break out of a loop
    """
r = []
for i in range(5):
    try:
        if i == 2:
            break
        r.append(i)
    finally:
        r.append('f%d' % i)
result = r
result
""",
    # finally runs on continue
    """
r = []
for i in range(3):
    try:
        if i == 1:
            continue
        r.append(i)
    finally:
        r.append('f')
result = r
result
""",
    # except tuple matching, and exception matching uses non-virtual bases
    # (ref 4.3)
    """
def kind(exc):
    try:
        raise exc
    except (TypeError, ValueError) as e:
        return 'tv:' + type(e).__name__
    except Exception as e:
        return 'other:' + type(e).__name__
result = (kind(ValueError()), kind(TypeError()), kind(KeyError()))
result
""",
    # bare `raise` re-raises the currently handled exception (ref 7.8)
    """
r = []
try:
    try:
        raise ValueError('v')
    except ValueError:
        r.append('inner')
        raise
except ValueError as e:
    r.append(str(e))
result = r
result
""",
    # implicit exception chaining sets __context__ (ref 7.8)
    """
try:
    try:
        raise ValueError('first')
    except ValueError:
        raise KeyError('second')
except KeyError as e:
    result = (str(e), type(e.__context__).__name__, str(e.__context__),
              e.__cause__ is None)
result
""",
    # `raise X from Y` sets __cause__ and __suppress_context__ (ref 7.8)
    """
try:
    try:
        raise ValueError('first')
    except ValueError as v:
        raise KeyError('second') from v
except KeyError as e:
    result = (type(e.__cause__).__name__, e.__suppress_context__,
              e.__cause__ is e.__context__)
result
""",
    # `raise X from None` clears __cause__ but keeps __context__
    """
try:
    try:
        raise ValueError('first')
    except ValueError:
        raise KeyError('second') from None
except KeyError as e:
    result = (e.__cause__ is None, e.__suppress_context__,
              type(e.__context__).__name__)
result
""",
    # `except ... as N` deletes N at the end of the clause -- so a value
    # captured out must be stashed explicitly (ref 8.4.1)
    """
saved = None
try:
    raise ValueError('v')
except ValueError as e:
    saved = str(e)
result = (saved, 'e' in dir())
result
""",
    # exception arguments and .args
    """
e = ValueError('a', 'b')
result = (e.args, str(e), len(e.args))
result
""",
    # exception group split by type [3.11+] (PEP 654)
    """
eg = ExceptionGroup('g', [ValueError(1), KeyError(2), ValueError(3)])
r = []
try:
    raise eg
except* ValueError as g:
    r.append(('V', len(g.exceptions)))
except* KeyError as g:
    r.append(('K', len(g.exceptions)))
result = r
result
""",
    # BaseExceptionGroup.__new__ type-switches to ExceptionGroup when every
    # leaf is an Exception (test_exception_group.py)
    """
g = BaseExceptionGroup('g', [ValueError(1)])
result = (type(g).__name__, isinstance(g, ExceptionGroup),
          isinstance(g.exceptions, tuple))
result
""",
    # eg.split preserves leaf order and partitions every leaf exactly once
    """
eg = ExceptionGroup('g', [ValueError(1), KeyError(2), ValueError(3)])
match, rest = eg.split(ValueError)
result = ([a.args[0] for a in match.exceptions],
          [a.args[0] for a in rest.exceptions])
result
""",
    # ------------------------------------------------------------------
    # 4. `with` STATEMENT  -- ref 8.5.
    # The exact expansion. contextlib's test_instance_bypass is direct
    # evidence for the type-lookup rule.
    # ------------------------------------------------------------------
    # __exit__ is called on the MANAGER, not on whatever __enter__ returned
    """
log = []
class Inner:
    def __exit__(self, *a):
        log.append('INNER-exit')
        return False
class Manager:
    def __enter__(self):
        return Inner()
    def __exit__(self, *a):
        log.append('MANAGER-exit')
        return False
with Manager() as v:
    log.append(type(v).__name__)
result = log
result
""",
    # __exit__ is loaded BEFORE __enter__ runs, so deleting it mid-__enter__
    # does not prevent the call (ref 8.5 expansion)
    """
log = []
class M:
    def __enter__(self):
        del type(self).__exit__
        return 'v'
    def __exit__(self, *a):
        log.append('exit')
        return False
with M() as v:
    log.append(v)
result = (log, hasattr(M, '__exit__'))
result
""",
    # a truthy __exit__ return SUPPRESSES the exception and execution resumes
    # AFTER the with block, not at the raise site (ref 8.5)
    """
r = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return True
with S():
    r.append(1)
    raise ValueError('x')
    r.append('unreachable')
r.append(3)
result = r
result
""",
    # a falsy __exit__ return lets the exception propagate
    """
r = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        r.append('exit')
        return None
try:
    with S():
        raise ValueError('x')
except ValueError:
    r.append('caught')
result = r
result
""",
    # __exit__ receives (type, value, traceback) and can inspect them
    """
seen = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, et, ev, tb):
        seen.append((et is ValueError, str(ev), tb is not None))
        return True
with S():
    raise ValueError('msg')
result = seen
result
""",
    # __exit__ gets (None, None, None) on normal exit
    """
seen = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, et, ev, tb):
        seen.append((et, ev, tb))
        return False
with S():
    pass
result = seen
result
""",
    # an exception raised while assigning the `as` TARGET still calls __exit__
    # (ref 8.5: the target assignment is inside the try)
    """
log = []
class M:
    def __enter__(self):
        return (1, 2, 3)
    def __exit__(self, et, ev, tb):
        log.append(et is ValueError)
        return True
with M() as (a, b):
    log.append('body-ran')
result = log
result
""",
    # `with A() as a, B() as b` is exactly nested withs: B exits first
    """
log = []
class M:
    def __init__(self, n):
        self.n = n
    def __enter__(self):
        log.append('enter' + self.n)
        return self.n
    def __exit__(self, *a):
        log.append('exit' + self.n)
        return False
with M('A') as a, M('B') as b:
    log.append('body' + a + b)
result = log
result
""",
    # the OUTER __exit__ can suppress an exception raised by the INNER __exit__
    """
log = []
class Outer:
    def __enter__(self):
        return self
    def __exit__(self, et, ev, tb):
        log.append('outer:' + type(ev).__name__)
        return True
class Inner:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        raise KeyError('from-inner-exit')
with Outer():
    with Inner():
        log.append('body')
log.append('after')
result = log
result
""",
    # `return` inside `with` still runs __exit__ before the function returns
    """
log = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        log.append('exit')
        return False
def f():
    with S():
        log.append('body')
        return 'ret'
v = f()
result = (v, log)
result
""",
    # __enter__/__exit__ set on the *class* are used even when the instance
    # dict has different ones (special method lookup on the type, ref 3.3.13)
    """
log = []
class M:
    def __enter__(self):
        log.append('class-enter')
        return 'C'
    def __exit__(self, *a):
        log.append('class-exit')
        return False
m = M()
m.__enter__ = lambda: log.append('inst-enter') or 'I'
m.__exit__ = lambda *a: log.append('inst-exit')
with m as v:
    log.append(v)
result = log
result
""",
    # break inside `with` still runs __exit__
    """
log = []
class S:
    def __enter__(self):
        return self
    def __exit__(self, *a):
        log.append('exit')
        return False
for i in range(3):
    with S():
        if i == 1:
            break
        log.append(i)
result = log
result
""",
    # ------------------------------------------------------------------
    # 5. DEFAULT ARGUMENTS  -- ref 6.3.3 / 8.7.
    # Evaluated ONCE, at def-execution time, in the enclosing scope.
    # smolagents evaluates defaults at CALL time against live state.
    # ------------------------------------------------------------------
    # the canonical mutable default: one list, shared across all calls
    """
def acc(x, into=[]):
    into.append(x)
    return list(into)
result = (acc(1), acc(2), acc(3))
result
""",
    # the default object is reachable via __defaults__ and is the same object
    """
def f(a=[]):
    a.append(1)
    return a
f()
f()
result = (f.__defaults__[0], len(f.__defaults__[0]))
result
""",
    # a default is a snapshot of the value at def time, not at call time
    """
n = 1
def f(x=n):
    return x
n = 99
result = (f(), f(2), n)
result
""",
    # defaults are evaluated left-to-right, once, at def time
    """
log = []
def side(tag):
    log.append(tag)
    return tag
def f(a=side('a'), b=side('b')):
    return (a, b)
before = list(log)
f()
f()
result = (before, log, f())
result
""",
    # a default expression is evaluated in the ENCLOSING scope, not the
    # function's own scope
    """
x = 'outer'
def f(a=x):
    x = 'inner'
    return a
result = f()
result
""",
    # keyword-only defaults follow the same rule
    """
def f(*, k=[]):
    k.append(1)
    return len(k)
result = (f(), f(), f(k=[]))
result
""",
    # lambda defaults are also evaluated once at lambda-creation time
    """
n = 0
g = lambda x=n: x
n = 5
result = (g(), g(7))
result
""",
    # ------------------------------------------------------------------
    # 6. CLOSURES AND LATE BINDING  -- ref 4.2.6, test_listcomps.py.
    # smolagents gets BOTH of the next two wrong, in opposite directions.
    # ------------------------------------------------------------------
    # closures capture the VARIABLE, not the value: all lambdas see the last i
    """
fs = []
for i in range(3):
    fs.append(lambda: i)
result = [f() for f in fs]
result
""",
    # a default argument freezes the value -- the standard workaround
    """
fs = []
for i in range(3):
    fs.append(lambda i=i: i)
result = [f() for f in fs]
result
""",
    # same pair, inside a comprehension (test_listcomps.py
    # test_lambdas_with_free_var / _with_iteration_var_as_default)
    """
free = [(lambda: i) for i in range(4)]
dflt = [(lambda i=i: i) for i in range(4)]
result = ([f() for f in free], [f() for f in dflt])
result
""",
    # a closure cell reflects rebinding of the enclosing local AFTER the def
    # (test_scope.py testSimpleAndRebinding)
    """
def make(x):
    def adder(y):
        return x + y
    x = x + 100
    return adder
result = make(0)(1)
result
""",
    # free variables resolve at CALL time, not at def time (ref 4.2.6)
    """
i = 10
def f():
    return i
i = 42
result = f()
result
""",
    # nonlocal rebinds the enclosing cell
    """
def outer():
    n = 0
    def bump():
        nonlocal n
        n += 1
        return n
    return (bump(), bump(), n)
result = outer()
result
""",
    # WITHOUT nonlocal, the inner assignment makes a fresh local
    """
def outer():
    n = 0
    def bump():
        n = 99
        return n
    inner = bump()
    return (inner, n)
result = outer()
result
""",
    # two levels of nonlocal target the SAME outermost cell
    # (test_scope.py testNestedNonLocal)
    """
def a():
    x = 'a'
    def b():
        nonlocal x
        x = 'b'
        def c():
            nonlocal x
            x = 'c'
        c()
        return x
    inner = b()
    return (inner, x)
result = a()
result
""",
    # `global` inside a nested function writes the module binding, and a
    # sibling nested function without `global` does not see it
    # (test_scope.py testGlobalInParallelNestedFunctions)
    """
y = 9
def outer():
    y = 1
    def g():
        global y
        return y
    def h():
        return y + 1
    return (g(), h())
result = (outer(), y)
result
""",
    # free variables pass through intermediate scopes that never use them
    """
def a(x):
    def b():
        def c():
            return x
        return c()
    return b()
result = a('deep')
result
""",
    # a generator closing over a nonlocal sees mutations across yields
    # (test_scope.py testNonLocalGenerator)
    """
def outer():
    n = 0
    def gen(k):
        for _ in range(k):
            nonlocal n
            n += 1
            yield n
    return list(gen(3)), n
result = outer()
result
""",
    # ------------------------------------------------------------------
    # 7. COMPREHENSION AND CLASS-BODY SCOPING -- ref 4.2.2, 6.2.9,
    #    test_listcomps.py, test_scope.py. Skulpt #921 mishandles DictComp
    #    and SetComp scope; Brython #1890 mishandles genexp-in-genexp.
    # ------------------------------------------------------------------
    # a comprehension target does not leak into the enclosing scope
    """
x = 'outer'
vals = [x for x in range(3)]
result = (vals, x)
result
""",
    # a comprehension inside a CLASS BODY cannot see class-body names --
    # it silently falls through to the GLOBAL of the same name (ref 4.2.2).
    # This is the flagship silent-wrong-answer case for class scoping.
    """
y = 'global-y'
class C:
    y = 'class-y'
    vals = [y for _ in range(2)]
result = C.vals
result
""",
    # ...but the LEFTMOST iterable IS evaluated in the class body's scope.
    # Contrast this with the snippet above; a re-implementation that treats
    # the whole comprehension uniformly gets exactly one of the two wrong.
    """
y = [1, 2, 3]
class C:
    y = ['class']
    vals = [i for i in y]
result = C.vals
result
""",
    # same rule with a dict comprehension
    """
k = 'global-k'
class C:
    k = 'class-k'
    d = {i: k for i in range(2)}
result = C.d
result
""",
    # same rule with a set comprehension (sorted for determinism)
    """
n = 10
class C:
    n = 99
    s = {i + n for i in range(3)}
result = sorted(C.s)
result
""",
    # same rule with a generator expression in a class body
    """
n = 5
class C:
    n = 500
    g = list(n + i for i in range(3))
result = C.g
result
""",
    # the class body's scope is NOT visible inside methods, and an enclosing
    # FUNCTION local wins over a same-named class attribute
    # (test_scope.py testFreeVarInMethod)
    """
def test():
    method_and_var = 'var'
    class T:
        def method_and_var(self):
            return 'method'
        def probe(self):
            return method_and_var
    return T().probe()
result = test()
result
""",
    # a class body sees GLOBALS, skipping the enclosing function's locals
    # (ref 4.2.2)
    """
x = 'global'
def outer():
    x = 'enclosing'
    class C:
        y = x
    return C.y
result = outer()
result
""",
    # `global` in a class body affects only the class body; a method's plain
    # assignment is a method local (test_scope.py testScopeOfGlobalStmt)
    """
x = 12
class G:
    global x
    x = 13
    def set(self, v):
        x = v
    def get(self):
        return x
g = G()
g.set(15)
result = (g.get(), x, 'x' in G.__dict__)
result
""",
    # `nonlocal` in a class body rebinds the enclosing function variable and
    # does NOT create a class attribute (test_scope.py testNonLocalClass)
    """
def f(x):
    class c:
        nonlocal x
        x += 1
        def get(self):
            return x
    return c(), x
inst, outer_x = f(0)
result = (inst.get(), outer_x, 'x' in type(inst).__dict__)
result
""",
    # locals() inside a class body must NOT contain free variables
    # (test_scope.py testLocalsClass)
    """
def f(x):
    class C:
        y = x
        z = sorted(k for k in locals() if not k.startswith('_'))
    return C.z
result = f(1)
result
""",
    # the leftmost iterable is evaluated in the enclosing scope, so
    # `[x for x in x]` is legal (test_listcomps.py test_shadow_comp_iterable_name)
    """
x = [1, 2, 3]
y = [x * 2 for x in x]
result = (y, x)
result
""",
    # inner comprehension cell shadows the outer name for the BODY but not
    # for the iterable (test_listcomps.py test_inner_cell_shadows_outer_no_store)
    """
def f(x):
    return [lambda: x for x in range(x)], x
fs, outer = f(2)
result = ([g() for g in fs], outer)
result
""",
    # a walrus inside a comprehension binds in the ENCLOSING scope
    # (ref 6.2.9, test_listcomps.py test_assignment_expression)
    """
def f():
    total = [(y := i) for i in range(3)]
    return total, y
result = f()
result
""",
    # walrus in a comprehension filter -- classic "compute once, use twice"
    """
data = [1, 2, 3, 4, 5, 6]
out = [z for n in data if (z := n * n) > 8]
result = (out, z)
result
""",
    # nested comprehension: the inner one re-evaluates per outer element
    """
result = [[j for j in range(i)] for i in range(4)]
result
""",
    # genexp inside genexp -- the case Brython #1890 gets wrong
    """
result = list(list(a for x in [2]) for a in [1])
result
""",
    # a comprehension does not leak even with multiple for-clauses
    """
b = 'kept'
out = [a for a in [1] for b in []]
result = (out, b)
result
""",
    # comprehension over a name that is later rebound: the ITERABLE object
    # was already captured for a listcomp (eager) -- contrast with genexp
    """
lst = [1, 2]
lc = [x for x in lst]
lst = [9, 9, 9]
result = (lc, lst)
result
""",
    # ------------------------------------------------------------------
    # 8. GENERATORS  -- ref 6.2.9, 6.2.10, 7.6, test_generators.py.
    # ------------------------------------------------------------------
    # a genexp's LEFTMOST iterable is evaluated EAGERLY, at construction
    # (ref 6.2.9). Rebinding the name afterwards is invisible.
    """
lst = [1, 2]
g = (x for x in lst)
lst = [9, 9, 9]
result = list(g)
result
""",
    # ...but MUTATING that same object IS visible, because only the object
    # was captured
    """
lst = [1, 2]
g = (x for x in lst)
lst.append(3)
result = list(g)
result
""",
    # everything after the leftmost iterable is lazy: the filter sees the
    # mutated value
    """
lim = 0
g = (x for x in [1, 2, 3] if x > lim)
lim = 2
result = list(g)
result
""",
    # a generator is exhausted after one pass -- the second list() is empty
    """
g = (i * 2 for i in range(3))
result = (list(g), list(g))
result
""",
    # partial consumption then resumption continues where it left off
    """
g = (i for i in range(5))
first = next(g)
second = next(g)
result = (first, second, list(g))
result
""",
    # next() with a default does not raise on exhaustion
    """
g = iter([1])
result = (next(g), next(g, 'DEFAULT'), next(g, 'DEFAULT'))
result
""",
    # a generator function body does not run until the first next()
    """
log = []
def gen():
    log.append('started')
    yield 1
    log.append('resumed')
    yield 2
g = gen()
before = list(log)
v = next(g)
result = (before, log, v)
result
""",
    # `return` in a generator sets StopIteration.value (ref 7.6)
    """
def gen():
    yield 1
    return 'RETVAL'
g = gen()
next(g)
try:
    next(g)
    result = 'no-stop'
except StopIteration as e:
    result = e.value
result
""",
    # `yield from` yields the subgenerator's values and evaluates to its
    # return value (ref 6.2.10)
    """
def sub():
    yield 'a'
    yield 'b'
    return 'SUBRET'
def outer():
    got = yield from sub()
    yield got
result = list(outer())
result
""",
    # yield from with a plain iterable has no return value (None)
    """
def outer():
    got = yield from [1, 2]
    yield repr(got)
result = list(outer())
result
""",
    # send() supplies the value of the CURRENT yield expression (ref 6.2.10)
    """
def echo():
    while True:
        got = yield
        if got is None:
            continue
        yield 'got:' + str(got)
g = echo()
next(g)
result = g.send(5)
result
""",
    # a running total driven by send()
    """
def acc():
    total = 0
    while True:
        x = yield total
        total += x
g = acc()
start = next(g)
result = (start, g.send(1), g.send(2), g.send(3))
result
""",
    # close() runs the generator's finally block
    """
log = []
def gen():
    try:
        yield 1
        yield 2
    finally:
        log.append('cleanup')
g = gen()
next(g)
g.close()
result = log
result
""",
    # throw() delivers the exception AT the yield point, where it can be caught
    """
def gen():
    try:
        yield 'a'
    except ValueError as e:
        yield 'caught:' + str(e)
g = gen()
next(g)
result = g.throw(ValueError('v'))
result
""",
    # a `yield` ANYWHERE in the body, even unreachable, makes the function a
    # generator (test_generators.py syntax_tests)
    """
def f():
    if False:
        yield
    return
def h():
    if False:
        def inner():
            yield 1
    return 'plain'
result = (type(f()).__name__, h())
result
""",
    # a lambda may contain a yield expression and then returns a generator
    """
x = lambda: ((yield 1), (yield 2))
result = list(x())
result
""",
    # `try: continue` with `finally: yield` (test_generators.py; was a
    # CPython crash in SF#567538)
    """
def f():
    for i in range(3):
        try:
            continue
        finally:
            yield i
result = list(f())
result
""",
    # yields inside nested try/except/finally execute in the documented order
    """
def f():
    try:
        try:
            yield 1
            raise ValueError('v')
        finally:
            yield 2
    except ValueError:
        yield 3
    finally:
        yield 4
result = list(f())
result
""",
    # a genexp calls __iter__ on its source exactly once
    # (test_generators.py test_genexpr_only_calls_dunder_iter_once)
    """
calls = []
class C:
    def __iter__(self):
        calls.append(1)
        return iter([1, 2, 3])
out = list(i for i in C())
result = (out, len(calls))
result
""",
    # zip stops at the shortest and does NOT over-consume the longer
    # iterator by more than one element
    """
a = iter([1, 2, 3, 4, 5])
b = [10, 20]
z = list(zip(a, b))
result = (z, list(a))
result
""",
    # map/filter are lazy in Python 3
    """
log = []
def f(x):
    log.append(x)
    return x * 2
m = map(f, [1, 2, 3])
before = list(log)
result = (before, next(m), log)
result
""",
    # any()/all() short-circuit over a generator
    """
seen = []
def probe(x):
    seen.append(x)
    return x > 1
r = any(probe(i) for i in range(5))
result = (r, seen)
result
""",
    """
seen = []
def probe(x):
    seen.append(x)
    return x < 2
r = all(probe(i) for i in range(5))
result = (r, seen)
result
""",
    # a genexp captures the loop variable by reference (late binding again)
    """
gens = []
for i in range(3):
    gens.append((i for _ in range(1)))
result = [list(g) for g in gens]
result
""",
    # ------------------------------------------------------------------
    # 9. AUGMENTED ASSIGNMENT  -- ref 7.2.1, test_augassign.py.
    # Skulpt #278 loses list aliasing on `*=`; Brython #1827 ignores
    # __imul__ for a subscript target; smolagents defaults an undefined
    # augassign target to 0.
    # ------------------------------------------------------------------
    # `+=` on a list mutates IN PLACE, so an alias sees the change
    """
a = [1]
b = a
a += [2]
result = (a, b, a is b)
result
""",
    # `a = a + [..]` REBINDS and the alias does not see it
    """
a = [1]
b = a
a = a + [2]
result = (a, b, a is b)
result
""",
    # `*=` on a list is in place
    """
a = [1]
b = a
a *= 3
result = (a, b, a is b)
result
""",
    # `+=` on a tuple rebinds (immutable)
    """
a = (1,)
b = a
a += (2,)
result = (a, b, a is b)
result
""",
    # `+=` on a str rebinds
    """
a = 'x'
b = a
a += 'y'
result = (a, b, a is b)
result
""",
    # augmented assignment to a SLICE mutates in place
    # (test_augassign.py testSequences)
    """
x = [1, 2, 3]
y = x
x[1:2] *= 2
y[1:2] += [99]
result = (x, x is y)
result
""",
    # a tuple holding a list: `t[0] += [..]` MUTATES and THEN raises
    # TypeError. The classic "both happened" case.
    """
t = ([1], 2)
err = None
try:
    t[0] += [9]
except TypeError as e:
    err = type(e).__name__
result = (t, err)
result
""",
    # augassign evaluates the target subscript ONCE, and the LHS BEFORE the
    # RHS -- the reverse of plain assignment (ref 7.2.1)
    """
log = []
def idx():
    log.append('idx')
    return 0
def val():
    log.append('val')
    return 5
a = [1]
a[idx()] += val()
result = (log, a)
result
""",
    # plain assignment evaluates the RHS FIRST, then the target (ref 6.16)
    """
log = []
def idx():
    log.append('idx')
    return 0
def val():
    log.append('val')
    return 5
a = [1]
a[idx()] = val()
result = (log, a)
result
""",
    # __iadd__ returning self => in place; absent => falls back to __add__
    # and rebinds (test_augassign.py testCustomMethods1)
    """
class NoIadd:
    def __init__(self, v):
        self.v = v
    def __add__(self, o):
        return NoIadd(self.v + o)
class SelfIadd:
    def __init__(self, v):
        self.v = v
    def __iadd__(self, o):
        self.v += o
        return self
class NewIadd:
    def __init__(self, v):
        self.v = v
    def __iadd__(self, o):
        return NewIadd(self.v + o + 100)
out = []
for cls in (NoIadd, SelfIadd, NewIadd):
    x = cls(1)
    y = x
    x += 10
    out.append((type(x).__name__, x.v, x is y))
result = out
result
""",
    # `|=` on a set mutates in place; `|` builds a new one
    """
a = {1}
b = a
a |= {2}
c = a | {3}
result = (sorted(a), a is b, sorted(c), c is a)
result
""",
    # `|=` on a dict mutates in place [3.9+]; later keys win
    """
d = {'a': 1, 'b': 2}
alias = d
d |= {'b': 20, 'c': 3}
result = (d, d is alias)
result
""",
    # augassign on a dict VALUE goes through __getitem__/__setitem__
    """
log = []
class D(dict):
    def __setitem__(self, k, v):
        log.append(('set', k, v))
        dict.__setitem__(self, k, v)
d = D(a=1)
d['a'] += 5
result = (dict(d), log)
result
""",
    # `/=` on an int produces a float
    """
x = 6
x /= 2
result = (x, type(x).__name__, x == 3)
result
""",
    # `//=` keeps int and floors toward -inf
    """
x = -7
x //= 3
result = x
result
""",
    # augassign on an attribute reads the CLASS attr and writes an INSTANCE
    # attr (ref 7.2)
    """
class C:
    n = 10
c = C()
c.n += 1
result = (c.n, C.n, 'n' in c.__dict__)
result
""",
    # ------------------------------------------------------------------
    # 10. ASSIGNMENT / UNPACKING  -- ref 7.2, test_unpack_ex.py, PEP 3132.
    # smolagents assigns nothing for a list-literal target (#2555) and
    # cannot do starred unpacking at all.
    # ------------------------------------------------------------------
    # targets are assigned strictly LEFT TO RIGHT (ref 7.2, the doc's own
    # example): i is bound before x[i] is stored into
    """
x = [0, 1]
i = 0
i, x[i] = 1, 2
result = (i, x)
result
""",
    # the RHS tuple is fully built first, which is why swap works
    """
a, b = 1, 2
a, b = b, a
result = (a, b)
result
""",
    # three-way rotate
    """
a, b, c = 1, 2, 3
a, b, c = c, a, b
result = (a, b, c)
result
""",
    # a starred target always produces a LIST, even from a tuple or a str
    """
a, *b, c = (1, 2, 3, 4)
p, *q = 'one'
result = (a, b, c, type(b).__name__, p, q)
result
""",
    # the starred target may be empty and may come first
    """
a, *b = [1]
*c, d = [1]
result = (a, b, c, d)
result
""",
    # `*a, = ...` -- the trailing comma makes it a target list
    """
*a, = 7, 8, 9
result = a
result
""",
    # nested starred targets
    """
(a, *b), c = [1, 2, 3], 4
result = (a, b, c)
result
""",
    # multiple target lists share one RHS and are assigned left to right
    # (test_unpack_ex.py)
    """
a, *b, c = *d, e = range(5)
result = (a, b, c, d, e)
result
""",
    # a list-literal target works exactly like a tuple target
    """
[a, b] = [1, 2]
[c] = (3,)
result = (a, b, c)
result
""",
    # unpacking falls back to the old __getitem__ iteration protocol
    # (test_unpack_ex.py)
    """
class Seq:
    def __getitem__(self, i):
        if i >= 3:
            raise IndexError(i)
        return i * 10
a, *b = Seq()
result = (a, b)
result
""",
    # self-referential unpack (test_unpack_ex.py)
    """
a, b, *c = range(5)
*a, b, c = a, b, *c
result = (a, b, c)
result
""",
    # `*` unpacking in a call is processed BEFORE keyword arguments even when
    # written after them (ref 6.3.3)
    """
log = []
def star():
    log.append('star')
    return (1,)
def kw():
    log.append('kw')
    return 2
def f(a, b):
    return (a, b)
v = f(b=kw(), *star())
result = (v, log)
result
""",
    # `*` and `**` in displays
    """
a = [1, 2]
b = (3,)
d1 = {'x': 1}
d2 = {'x': 9, 'y': 2}
result = ([*a, *b, 4], {**d1, **d2}, {**d2, **d1})
result
""",
    # dict display: LAST duplicate key wins, including through ** unpackings
    # (ref 6.2.7, test_unpack_ex.py)
    """
result = ({**{'x': 1}, **{'x': 3}, 'x': 4}, {0: 1, **{0: 2}, 0: 3, 0: 4})
result
""",
    # `{**a}` is a shallow COPY
    """
a = {'k': [1]}
b = {**a}
b['new'] = 1
b['k'].append(2)
result = (a, b, a['k'] is b['k'])
result
""",
    # a starred generator argument is consumed once
    """
def f(*args):
    return args
g = (i for i in range(3))
result = (f(*g), f(*g))
result
""",
    # ------------------------------------------------------------------
    # 11. CHAINED COMPARISON AND SHORT CIRCUIT  -- ref 6.10, 6.11.
    # Brython #2374 does not implement chaining for mixed operators.
    # ------------------------------------------------------------------
    # the middle operand is evaluated exactly ONCE (ref 6.10)
    """
calls = []
def y():
    calls.append('y')
    return 5
result = (1 < y() < 10, len(calls))
result
""",
    # chained comparison short-circuits: the third operand is never evaluated
    """
calls = []
def z():
    calls.append('z')
    return 0
result = (10 < 5 < z(), calls)
result
""",
    # chaining across MIXED operators: `a in b == c` is
    # `(a in b) and (b == c)`, not `a in (b == c)`
    """
result = (1 in [1] == True, (1 in [1]) and ([1] == True))
result
""",
    # a long chain with a side effect in the middle
    """
calls = []
def m(v):
    calls.append(v)
    return v
result = (0 < m(1) < m(2) < m(3) > m(9), calls)
result
""",
    # `and`/`or` return an OPERAND, not a bool (ref 6.11)
    """
result = (0 or [], '' and 3, [] or 'fallback', 'a' and 'b', 0 or 0.0 or None)
result
""",
    # `not` always returns a bool
    """
result = (not 'foo', not '', not [], type(not 1).__name__)
result
""",
    # short circuit means the right operand is never evaluated
    """
calls = []
def side():
    calls.append(1)
    return True
r = (False and side(), True or side())
result = (r, calls)
result
""",
    # the conditional expression evaluates the CONDITION first, then exactly
    # one branch (ref 6.13)
    """
log = []
def t(tag):
    log.append(tag)
    return tag
v = t('yes') if t('cond') else t('no')
result = (v, log)
result
""",
    # `is not` / `not in` are single operators
    """
result = (1 not in [2, 3], [] is not [], 'a' not in 'bcd')
result
""",
    # ------------------------------------------------------------------
    # 12. OPERATOR DISPATCH AND REFLECTED OPERATORS -- ref 3.3.8.
    # Skulpt #155 falls back to the LHS slot instead of the reflected one.
    # ------------------------------------------------------------------
    # if the RIGHT operand's type is a SUBCLASS of the left's, its reflected
    # method has priority (ref 3.3.8)
    """
class A:
    def __add__(self, o):
        return 'A.__add__'
class B(A):
    def __radd__(self, o):
        return 'B.__radd__'
result = (A() + B(), B() + A())
result
""",
    # without a subclass relationship, the LEFT operand's __add__ always wins,
    # whichever way round the operands are written
    """
class L:
    def __add__(self, o):
        return 'L.__add__'
    def __radd__(self, o):
        return 'L.__radd__'
class R:
    def __add__(self, o):
        return 'R.__add__'
    def __radd__(self, o):
        return 'R.__radd__'
result = (L() + R(), R() + L())
result
""",
    # returning NotImplemented falls through to the reflected method
    """
log = []
class L:
    def __add__(self, o):
        log.append('L.add')
        return NotImplemented
class R:
    def __radd__(self, o):
        log.append('R.radd')
        return 'reflected'
result = (L() + R(), log)
result
""",
    # the same subclass-priority rule applies to rich comparisons
    """
class A:
    def __lt__(self, o):
        return 'A.__lt__'
class B(A):
    def __gt__(self, o):
        return 'B.__gt__'
result = (A() < B(), B() > A())
result
""",
    # `<` and `>` are each other's reflection
    """
class Only:
    def __gt__(self, o):
        return 'gt'
result = (1 < Only(), Only() > 1)
result
""",
    # __ne__ is derived from __eq__ by inversion unless overridden (ref 3.3.1)
    """
class E:
    def __init__(self, v):
        self.v = v
    def __eq__(self, o):
        return isinstance(o, E) and self.v == o.v
    __hash__ = object.__hash__
result = (E(1) == E(1), E(1) != E(1), E(1) != E(2), E(1) == 5, E(1) != 5)
result
""",
    # object.__eq__ returns NotImplemented (not False) for non-identical
    # objects, so `==` falls back to `is`
    """
class Plain:
    pass
p = Plain()
result = (p == p, p == Plain(), Plain().__eq__(Plain()) is NotImplemented)
result
""",
    # int.__add__ with an unsupported type returns NotImplemented rather than
    # raising (PyPy differs from CPython on the list variant)
    """
result = ((1).__add__(None) is NotImplemented,
          (1).__add__(2))
result
""",
    # in-place operator falls back through __iadd__ -> __add__ -> __radd__
    """
order = []
class X:
    def __radd__(self, o):
        order.append('radd')
        return 'X.radd'
v = [1]
w = 5
w += 0
y = X()
z = 1
z += y
result = (z, order)
result
""",
    # `@` matmul dispatches to __matmul__ / __rmatmul__ / __imatmul__
    # (test_augassign.py testCustomMethods2)
    """
trace = []
class M:
    def __matmul__(self, o):
        trace.append('matmul')
        return 'm'
    def __rmatmul__(self, o):
        trace.append('rmatmul')
        return 'rm'
    def __imatmul__(self, o):
        trace.append('imatmul')
        return 'im'
x = M()
a = x @ 1
b = 1 @ x
x @= 1
result = (a, b, x, trace)
result
""",
    # `/` and `//` are distinct slots
    """
trace = []
class D:
    def __truediv__(self, o):
        trace.append('truediv')
        return 't'
    def __floordiv__(self, o):
        trace.append('floordiv')
        return 'f'
d = D()
result = (d / 1, d // 1, trace)
result
""",
    # ------------------------------------------------------------------
    # 13. DATA MODEL: ATTRIBUTES, DESCRIPTORS, SPECIAL METHODS -- ref 3.3.2,
    #     3.3.2.3, 3.3.13, 3.2.10.
    # ------------------------------------------------------------------
    # DATA descriptor beats the instance dict; NON-data descriptor loses to it
    # (ref 3.3.2.3)
    """
class Data:
    def __get__(self, o, t=None):
        return 'data-desc'
    def __set__(self, o, v):
        pass
class NonData:
    def __get__(self, o, t=None):
        return 'nondata-desc'
class C:
    x = Data()
    y = NonData()
c = C()
c.__dict__['x'] = 'from-instance'
c.__dict__['y'] = 'from-instance'
result = (c.x, c.y)
result
""",
    # __getattr__ fires only when normal lookup raises AttributeError --
    # including when a property's own getter raises it. Classic silent bug.
    """
log = []
class C:
    @property
    def p(self):
        log.append('property-ran')
        raise AttributeError('inner')
    def __getattr__(self, name):
        return 'getattr:' + name
result = (C().p, log)
result
""",
    # __getattribute__ intercepts EVERYTHING, __getattr__ only misses
    """
calls = []
class C:
    a = 1
    def __getattribute__(self, name):
        calls.append(name)
        return object.__getattribute__(self, name)
    def __getattr__(self, name):
        return 'fallback'
c = C()
result = (c.a, c.missing, calls)
result
""",
    # implicit special-method lookup goes to the TYPE and bypasses the
    # instance dict (ref 3.3.13)
    """
class C:
    def __len__(self):
        return 0
c = C()
c.__len__ = lambda: 99
result = (len(c), c.__len__(), bool(c))
result
""",
    # truthiness: __bool__, else __len__ != 0, else True (ref 3.3.1)
    """
class NoDunders:
    pass
class HasLen:
    def __len__(self):
        return 0
class HasBool:
    def __bool__(self):
        return False
    def __len__(self):
        return 5
result = (bool(NoDunders()), bool(HasLen()), bool(HasBool()))
result
""",
    # a plain function stored in the INSTANCE dict is not bound as a method
    # (ref 3.2.11)
    """
class C:
    def method(self):
        return 'bound:' + type(self).__name__
c = C()
c.attached = lambda: 'unbound-plain'
result = (c.method(), c.attached(), type(c.method).__name__)
result
""",
    # attribute lookup follows the C3 MRO (ref 3.2.10)
    """
class A:
    def who(self):
        return 'A'
class B(A):
    pass
class C(A):
    def who(self):
        return 'C'
class D(B, C):
    pass
result = ([k.__name__ for k in D.__mro__], D().who())
result
""",
    # cooperative super() through a diamond visits every class once
    """
order = []
class A:
    def go(self):
        order.append('A')
class B(A):
    def go(self):
        order.append('B')
        super().go()
class C(A):
    def go(self):
        order.append('C')
        super().go()
class D(B, C):
    def go(self):
        order.append('D')
        super().go()
D().go()
result = order
result
""",
    # zero-argument super() works inside a method via the __class__ cell
    """
class Base:
    def f(self):
        return 'base'
class Sub(Base):
    def f(self):
        return 'sub+' + super().f()
result = Sub().f()
result
""",
    # __slots__ blocks the instance dict but slot assignment works; a
    # subclass that omits __slots__ gets a dict back (ref 3.3.2.4)
    """
class S:
    __slots__ = ('a',)
class Sub(S):
    pass
s = S()
s.a = 1
sub = Sub()
sub.b = 2
result = (s.a, hasattr(s, '__dict__'), sub.b, hasattr(sub, '__dict__'))
result
""",
    # a special method set to None DISABLES the operation without falling
    # back (ref 3.3.1; test_augassign.py aug_test4)
    """
class NoIter:
    __iter__ = None
    def __getitem__(self, i):
        return i
err = None
try:
    list(NoIter())
except TypeError as e:
    err = 'TypeError'
result = (err, NoIter()[3])
result
""",
    # __index__ (not __int__) is what indexing and slicing require (ref 3.3.8)
    """
class Idx:
    def __index__(self):
        return 2
class Num:
    def __int__(self):
        return 2
lst = [10, 20, 30, 40]
err = None
try:
    lst[Num()]
except TypeError:
    err = 'TypeError'
result = (lst[Idx()], lst[Idx():], hex(Idx()), err)
result
""",
    # slicing builds a slice object with None for the missing parts (ref 6.3.2)
    """
seen = []
class C:
    def __getitem__(self, k):
        seen.append((type(k).__name__, getattr(k, 'start', k),
                     getattr(k, 'stop', None), getattr(k, 'step', None)))
        return 'ok'
c = C()
c[1]
c[::2]
c[1:2]
c[::-1]
result = seen
result
""",
    # __set_name__ is called on every descriptor at class creation, in
    # definition order (ref 3.3.3)
    """
order = []
class Named:
    def __set_name__(self, owner, name):
        order.append((owner.__name__, name))
    def __get__(self, o, t=None):
        return 'v'
class C:
    first = Named()
    second = Named()
result = order
result
""",
    # __init_subclass__ is an implicit classmethod, called on the PARENT for
    # each subclass, and not for the defining class (ref 3.3.3)
    """
seen = []
class Base:
    def __init_subclass__(cls, **kw):
        seen.append(cls.__name__)
        super().__init_subclass__(**kw)
class Kid(Base):
    pass
class GrandKid(Kid):
    pass
result = seen
result
""",
    # __new__ returning something that is not an instance of cls SKIPS
    # __init__ entirely (ref 3.3.1)
    """
log = []
class C:
    def __new__(cls, *a):
        log.append('new')
        return 'A-STRING'
    def __init__(self, *a):
        log.append('init')
v = C(1)
result = (v, log)
result
""",
    # ...and returning a proper instance DOES run __init__
    """
log = []
class C:
    def __new__(cls, *a):
        log.append('new')
        return super().__new__(cls)
    def __init__(self, v):
        log.append('init')
        self.v = v
c = C(7)
result = (c.v, log)
result
""",
    # class body executes top to bottom and __dict__ preserves definition
    # order (ref 8.8)
    """
log = []
class C:
    log.append('body-start')
    zeta = 1
    alpha = 2
    def m(self):
        pass
    middle = 3
result = ([k for k in C.__dict__ if not k.startswith('_')], log)
result
""",
    # a class body is a real executing block: names are visible to later
    # statements in the same body
    """
class C:
    a = 2
    b = a * 3
    c = [a, b]
result = (C.a, C.b, C.c)
result
""",
    # dict subclass __missing__ is consulted by __getitem__ but not by .get
    """
class D(dict):
    def __missing__(self, k):
        return 'missing:' + k
d = D(a=1)
result = (d['a'], d['zz'], d.get('zz'), d.get('zz', 'dflt'), 'zz' in d)
result
""",
    # `in` falls back __contains__ -> __iter__ -> __getitem__ (ref 6.10.2)
    """
class ByIter:
    def __iter__(self):
        return iter([1, 2, 3])
class ByGetItem:
    def __getitem__(self, i):
        if i > 2:
            raise IndexError(i)
        return i * 5
result = (2 in ByIter(), 9 in ByIter(), 5 in ByGetItem(), 7 in ByGetItem())
result
""",
    # membership uses `x is e or x == e` -- identity FIRST, which is why a
    # NaN is found in a list containing itself (ref 6.10.2)
    """
n = float('nan')
result = (n == n, n in [n], [n] == [n], n in (1.0, n))
result
""",
    # NaN ordering: every comparison is False, so `not (a < b)` is not
    # `a >= b`
    """
n = float('nan')
result = (n < 1, n > 1, n == 1, n != 1, n <= n, sorted([1, 2]) == [1, 2])
result
""",
    # `in` on a str is SUBSTRING containment, not element containment
    """
result = ('' in 'abc', 'ab' in 'xaby', 'ba' in 'abc', 'a' in 'abc')
result
""",
    # property getter/setter/deleter
    """
log = []
class C:
    def __init__(self):
        self._v = 0
    @property
    def v(self):
        log.append('get')
        return self._v
    @v.setter
    def v(self, val):
        log.append('set')
        self._v = val * 2
c = C()
c.v = 5
result = (c.v, log)
result
""",
    # classmethod receives the class; staticmethod receives nothing
    """
class C:
    tag = 'C'
    @classmethod
    def cm(cls):
        return 'cm:' + cls.tag
    @staticmethod
    def sm(x):
        return 'sm:' + str(x)
class Sub(C):
    tag = 'Sub'
result = (C.cm(), Sub.cm(), C().cm(), C.sm(1), C().sm(2))
result
""",
    # __call__ makes an instance callable
    """
class Adder:
    def __init__(self, n):
        self.n = n
    def __call__(self, x):
        return x + self.n
add3 = Adder(3)
result = (add3(4), list(map(add3, [1, 2])))
result
""",
    # __str__ defaults to __repr__ but not the reverse (ref 3.3.1)
    """
class OnlyRepr:
    def __repr__(self):
        return 'REPR'
class OnlyStr:
    def __str__(self):
        return 'STR'
result = (str(OnlyRepr()), repr(OnlyRepr()), str(OnlyStr()),
          repr(OnlyStr()).startswith('<'))
result
""",
    # repr, not str, is used for elements inside a container (RustPython #79)
    """
result = (str(['', 'a']), str({'k': 'v'}), str(('x',)), str([None, True]))
result
""",
    # a metaclass may customise class creation
    """
log = []
class Meta(type):
    def __new__(mcls, name, bases, ns):
        log.append('meta-new:' + name)
        ns['injected'] = 'yes'
        return super().__new__(mcls, name, bases, ns)
class C(metaclass=Meta):
    pass
result = (C.injected, log, type(C).__name__)
result
""",
    # ------------------------------------------------------------------
    # 14. ARITHMETIC: FLOOR DIVISION, MODULO, SIGNS -- ref 6.7, 6.8.
    # RustPython #937 gave -1 // 2 == 0; Skulpt #1325 used the JS remainder
    # for big negative ints; Brython #2377 breaks ~ past 32 bits.
    # ------------------------------------------------------------------
    # `%` takes the sign of the RIGHT operand; `//` floors toward -inf
    """
result = (-7 // 3, -7 % 3, 7 // -3, 7 % -3, 7 // 3, 7 % 3, -1 // 2)
result
""",
    # the identity x == (x // y) * y + (x % y) holds for every sign
    """
pairs = [(7, 3), (-7, 3), (7, -3), (-7, -3), (0, 5), (0, -5)]
result = [(x, y, x // y, x % y, x == (x // y) * y + x % y) for x, y in pairs]
result
""",
    # divmod agrees with // and % for every sign combination
    """
result = [divmod(a, b) for a, b in
          ((7, 3), (-7, 3), (7, -3), (-7, -3))]
result
""",
    # float floor division and modulo follow the same sign rule
    """
result = (-7.0 // 3.0, -7.0 % 3.0, 7.0 % -3.0, divmod(-7.0, 3.0))
result
""",
    # divmod with a zero remainder must not sign-correct (RustPython #7722)
    """
result = (repr(divmod(0, -1.0)), repr(divmod(0.0, -1.0)), repr(-0.0 == 0.0))
result
""",
    # shifts: `x >> n` is `x // 2**n` (floors), so -1 >> 1 stays -1 (ref 6.8)
    """
result = (-1 >> 1, -1 >> 10, -5 >> 1, 5 >> 1, 1 << 5, -1 << 3)
result
""",
    # shifts beyond 32/53 bits stay exact (Skulpt #1291, Brython)
    """
result = ((1 << 34) >> 33, (170 << 28) >> 27, (1 << 64) >> 60,
          (1 << 100) >> 99)
result
""",
    # `~` on a large value is exact (Brython #2377)
    """
result = (~0, ~-1, ~((1 << 64) - 1), ~((1 << 31) - 1))
result
""",
    # big-int arithmetic is exact beyond 2**53 (Brython/Skulpt seam)
    """
big = 2 ** 53
result = (big + 1 - big, big * big // big, 10 ** 20 + 1 - 10 ** 20,
          (2 ** 64) % 7)
result
""",
    # big negative modulo (Skulpt #1325 returned -3 instead of 1)
    """
x = -int('1' * 40)
result = (x % 4, x % 7, x // 4, abs(x) % 4)
result
""",
    # `-2 ** 2` is -4: unary minus binds looser than ** (ref 2.6)
    """
result = (-2 ** 2, (-2) ** 2, 2 ** -1, -2 ** -2)
result
""",
    # ** is RIGHT associative
    """
result = (2 ** 3 ** 2, (2 ** 3) ** 2)
result
""",
    # int / int is always a float; int // int is an int (ref 6.7)
    """
result = (6 / 3, type(6 / 3).__name__, 6 // 3, type(6 // 3).__name__,
          6 / 4)
result
""",
    # bool is a subclass of int and works as an index
    """
result = (True + True, True * 3, [10, 20][True], sum([True, True, False]),
          isinstance(True, int), True == 1, True is 1 - 0 + True - True + True)
result
""",
    # 1, 1.0 and True are the same dict key and the same set element
    """
d = {1: 'int'}
d[1.0] = 'float'
d[True] = 'bool'
result = (d, len({1, 1.0, True}), hash(1) == hash(1.0) == hash(True))
result
""",
    # round() uses banker's rounding (ties to even) -- NOT away from zero
    """
result = (round(0.5), round(1.5), round(2.5), round(3.5), round(-0.5),
          round(-1.5), round(-2.5))
result
""",
    # round(x, n) is subject to binary representation (RustPython #1554)
    """
result = (round(2.675, 2), round(1.005, 2), round(2.5, 0),
          type(round(2.5, 0)).__name__, type(round(2.5)).__name__)
result
""",
    # float arithmetic is IEEE-754, so these must NOT be "fixed up"
    """
result = (repr(0.1 + 0.2), 0.1 + 0.2 == 0.3, repr(sum([0.1] * 10)),
          repr(1e16 + 1.0))
result
""",
    # signed zero and infinities
    """
inf = float('inf')
result = (repr(-0.0), -0.0 == 0.0, repr(1 / inf), repr(-1 / inf),
          inf > 10 ** 100, repr(inf - inf) == 'nan')
result
""",
    # three-argument pow, including the modular inverse form [3.8+]
    # (Brython #2407 returned a negative value)
    """
result = (pow(2, 10, 1000), pow(3, -1, 7), pow(65537, -1, 100),
          pow(2, 0, 5), pow(-2, 3, 5))
result
""",
    # int() truncates toward zero, while // floors
    """
result = (int(-2.7), int(2.7), -2.7 // 1, 2.7 // 1, int('-42'), int('  7 '))
result
""",
    # int with a base, and the underscore separator
    """
result = (int('ff', 16), int('0b101', 0), int('1_000'), int('-0x1f', 16),
          0x_1f, 1_000_000)
result
""",
    # abs / min / max ties return the FIRST equal element
    """
a = 1.0
b = 1
result = (min(a, b) is a, max(b, a) is b, min([3, 1, 1]), abs(-0.0) == 0.0,
          repr(abs(-0.0)))
result
""",
    # bit_length and to_bytes-free integer introspection
    """
result = ((255).bit_length(), (0).bit_length(), (-255).bit_length(),
          (1 << 100).bit_length())
result
""",
    # sum() with a start value; sum of floats is left-to-right
    """
result = (sum([1, 2, 3]), sum([1, 2], 10), sum([]),
          repr(sum([0.1, 0.2, 0.3])), sum([[1], [2]], []))
result
""",
    # ------------------------------------------------------------------
    # 15. STRING METHODS AND FORMATTING -- ref 2.5, library string methods.
    # ------------------------------------------------------------------
    # split() with no argument collapses runs of whitespace and strips ends;
    # split(' ') does neither
    """
s = '  a  b  '
result = (s.split(), s.split(' '), 'a,b,'.split(','), ''.split(','),
          ''.split())
result
""",
    # maxsplit, and rsplit counts from the right
    """
s = 'a-b-c-d'
result = (s.split('-', 1), s.rsplit('-', 1), s.split('-', 0),
          s.rsplit('-', 99))
result
""",
    # partition/rpartition always return a 3-tuple
    """
result = ('a=b=c'.partition('='), 'a=b=c'.rpartition('='),
          'abc'.partition('='), 'abc'.rpartition('='))
result
""",
    # strip/lstrip/rstrip take a CHARACTER SET, not a prefix
    """
result = ('cbaXbac'.strip('abc'), 'xxhixx'.strip('x'),
          'mississippi'.strip('mip'), 'abcabc'.lstrip('cba'))
result
""",
    # removeprefix/removesuffix DO take a literal affix [3.9+]
    """
result = ('cbaXbac'.removeprefix('abc'), 'abcXabc'.removeprefix('abc'),
          'abcXabc'.removesuffix('abc'), 'abc'.removeprefix('zz'))
result
""",
    # replace with a count, and replacement of the empty string
    """
result = ('aaaa'.replace('a', 'b', 2), 'aaa'.replace('aa', 'b'),
          'abc'.replace('', '-'), 'abc'.replace('x', 'y'))
result
""",
    # count is non-overlapping
    """
result = ('aaaa'.count('aa'), 'aaa'.count('a'), 'abc'.count(''),
          'aaa'.count('a', 1))
result
""",
    # find returns -1, index raises -- and both accept start/end
    """
err = None
try:
    'abc'.index('z')
except ValueError:
    err = 'ValueError'
result = ('abc'.find('z'), 'abcabc'.find('b', 2), 'abc'.rfind('c'), err)
result
""",
    # str * n with n <= 0 gives the empty string
    """
result = ('ab' * 0, 'ab' * -3, 'ab' * 2, [1] * -1, (1,) * 0)
result
""",
    # startswith/endswith accept a tuple of candidates
    """
result = ('abc'.startswith(('x', 'ab')), 'abc'.endswith('bc', 0, 2),
          'abc'.startswith(''), 'abc'.startswith('b', 1))
result
""",
    # title() and capitalize() have surprising apostrophe / digit rules
    """
result = ("they're ok".title(), 'a1b'.title(), 'HELLO world'.capitalize(),
          'ábc'.capitalize())
result
""",
    # German sharp s uppercases to two characters -- len changes
    """
s = 'straße'
u = s.upper()
result = (u, len(s), len(u), u.lower(), 'SS'.lower())
result
""",
    # casefold is more aggressive than lower
    """
result = ('ß'.lower(), 'ß'.casefold(), 'ß'.upper().casefold(),
          'İ'.lower() == 'i')
result
""",
    # isdigit / isdecimal / isnumeric differ on superscripts and fractions
    """
result = ('²'.isdigit(), '²'.isdecimal(), '²'.isnumeric(),
          '½'.isdigit(), '½'.isnumeric(), '7'.isdecimal())
result
""",
    # zfill keeps the sign in front of the padding
    """
result = ('-42'.zfill(5), '42'.zfill(5), '+42'.zfill(5), '-42'.rjust(5, '0'),
          ''.zfill(2))
result
""",
    # expandtabs uses tab stops, not a fixed replacement
    r"""
result = ('ab\tc'.expandtabs(4), 'a\tb'.expandtabs(4), '\t'.expandtabs(4),
          'abcd\te'.expandtabs(4))
result
""",
    # splitlines is not split('\n'): no trailing empty, and more separators
    r"""
s = 'a\nb\n'
result = (s.splitlines(), s.split('\n'), 'a\r\nb'.splitlines(),
          'a\x0bb'.splitlines(), ''.splitlines())
result
""",
    # join over a generator, and join of an empty iterable
    """
result = (','.join(str(i) for i in range(3)), ''.join([]), '-'.join('abc'),
          ','.join(['x']))
result
""",
    # center/ljust/rjust padding distribution when the pad is odd
    """
result = ('ab'.center(7, '.'), 'ab'.center(5, '.'), 'ab'.ljust(5, '.'),
          'abcdef'.center(3))
result
""",
    # str.translate via maketrans, including deletion
    """
tbl = str.maketrans('abc', 'xyz', 'd')
result = ('abcd'.translate(tbl), 'dddd'.translate(tbl), 'zzz'.translate(tbl))
result
""",
    # implicit adjacent-literal concatenation happens at compile time (ref 2.5)
    """
s = 'a' 'b' "c"
result = (s, len(s), 'x' 'y' == 'xy')
result
""",
    # raw strings keep backslashes; a raw string is not a different type
    r"""
result = (len(r'\n'), len('\n'), r'\t' == '\\t', repr(r'a\'b'))
result
""",
    # format spec: alignment, sign, thousands separator, percent
    """
result = ('{:>5}'.format('ab'), '{:<5}|'.format('ab'), '{:^5}|'.format('ab'),
          '{:+.2f}'.format(1.5), '{:,}'.format(1234567), '{:.1%}'.format(0.256))
result
""",
    # format spec on floats: rounding is on the binary value
    """
result = ('{:.2f}'.format(2.675), '{:.2f}'.format(1.005),
          '{:.0f}'.format(0.5), '{:.0f}'.format(1.5), '{:g}'.format(100000.0))
result
""",
    # %-formatting, including %G and the tuple-argument rule
    """
result = ('%.4G' % 0.0000045, '%d' % 3.99, '%s' % ((1, 2),), '%5.2f' % 3.14159,
          '%x' % 255, '%%')
result
""",
    # str.format positional reuse and auto-numbering
    """
result = ('{0}{0}{1}'.format('x', 'y'), '{}{}'.format(1, 2),
          '{a}-{a}'.format(a=3), '{0[1]}'.format([9, 8]))
result
""",
    # format_map does not copy and consults __missing__
    """
class D(dict):
    def __missing__(self, k):
        return '<' + k + '>'
result = '{a}{b}'.format_map(D(a=1))
result
""",
    # f-string `=` emits the literal source text then the repr (ref 2.5.7)
    """
x = 5
name = 'hi'
result = (f'{x+1=}', f'{x =}', f'{name=}', f'{name=!s}')
result
""",
    # f-string conversions !r / !s / !a (smolagents drops these)
    """
class C:
    def __repr__(self):
        return 'REPR'
    def __str__(self):
        return 'STR'
c = C()
result = (f'{c}', f'{c!r}', f'{c!s}', f'{"héllo"!a}')
result
""",
    # nested format specs, one level deep (ref 2.5.7)
    """
n = 3.14159
w = 8
p = 2
result = (f'{n:{w}.{p}f}', f'{n:{w}}', f'{42:{"0"}{5}d}')
result
""",
    # doubled braces collapse outside replacement fields
    """
x = 5
result = (f'{{{x}}}', f'{{}}', '{{}}'.format(), f'{{{{')
result
""",
    # f-strings are evaluated left to right at runtime and are never docstrings
    """
log = []
def side(t):
    log.append(t)
    return t
s = f'{side("a")}{side("b")}'
def foo():
    f'not a docstring'
result = (s, log, foo.__doc__)
result
""",
    # a conversion runs BEFORE the format spec, so !s makes the spec a STRING
    # spec -- '>8' still works but a numeric code like '.3f' would not
    """
vals = [1.23456, 10.5]
result = [(f'{v:>10.3f}', f'{v!s:>8}') for v in vals]
result
""",
    # ------------------------------------------------------------------
    # 16. SEQUENCES, SLICING, DICTS, SORTING
    # ------------------------------------------------------------------
    # out-of-range slices CLAMP rather than raise (unlike indexing)
    """
l = [1, 2, 3]
result = (l[5:10], l[-100:], l[:100], l[2:1], l[-1:], l[100:200])
result
""",
    # negative-step slicing and the omitted-endpoint asymmetry
    """
l = [0, 1, 2, 3, 4]
result = (l[::-1], l[::2], l[::-2], l[3:0:-1], l[3::-1], l[:2:-1])
result
""",
    # slice assignment can CHANGE the length
    """
l = [1, 2, 3]
l[1:2] = [9, 9, 9]
m = [1, 2, 3]
m[1:1] = [0]
n = [1, 2, 3]
n[:] = []
result = (l, m, n)
result
""",
    # extended-slice deletion
    """
l = list(range(6))
del l[::2]
m = list(range(6))
del m[1:3]
result = (l, m)
result
""",
    # `[[0]] * 3` makes THREE REFERENCES to one list
    """
a = [[0]] * 3
a[0].append(1)
b = [[0] for _ in range(3)]
b[0].append(1)
result = (a, b)
result
""",
    # `l[:]` is a shallow copy: nested objects are shared
    """
orig = [[1], 2]
copy = orig[:]
copy[0].append(9)
copy[1] = 99
result = (orig, copy)
result
""",
    # list.insert clamps, list.remove removes the FIRST match
    """
l = [1, 2, 1]
l.insert(100, 'end')
l.insert(-100, 'start')
l.remove(1)
result = (l, [1, 2, 1].index(1, 1))
result
""",
    # sequence comparison is lexicographic and shorter-is-less
    """
result = ([1, 2] < [1, 2, 3], [1, 2] == (1, 2), [1, 3] > [1, 2, 9],
          [] < [0], 'abc' < 'abd', (1, 2) < (1, 2, 0))
result
""",
    # dict preserves INSERTION order; updating a key keeps its position;
    # deleting and reinserting moves it to the end
    """
d = {'a': 1, 'b': 2, 'c': 3}
d['a'] = 99
keys_after_update = list(d)
del d['b']
d['b'] = 2
result = (keys_after_update, list(d), list(d.values()))
result
""",
    # popitem is LIFO
    """
d = {'a': 1, 'b': 2, 'c': 3}
result = (d.popitem(), d.popitem(), list(d))
result
""",
    # a dict literal's duplicate keys: LAST wins, but the POSITION is the
    # first occurrence
    """
d = {'a': 1, 'b': 2, 'a': 3}
result = (d, list(d))
result
""",
    # dict.get / setdefault evaluate their default EAGERLY
    """
log = []
def default():
    log.append('called')
    return 'D'
d = {'a': 1}
r1 = d.get('a', default())
r2 = d.setdefault('a', default())
r3 = d.setdefault('b', default())
result = (r1, r2, r3, d, len(log))
result
""",
    # dict views are live
    """
d = {'a': 1}
ks = d.keys()
d['b'] = 2
result = (sorted(ks), len(ks), ('a', 1) in d.items())
result
""",
    # sorted() is STABLE: equal keys keep their input order
    """
data = [('c', 1), ('a', 1), ('b', 0), ('d', 1)]
result = sorted(data, key=lambda t: t[1])
result
""",
    # reverse=True does NOT reverse the order of equal elements
    """
data = [('c', 1), ('a', 1), ('b', 0), ('d', 1)]
result = (sorted(data, key=lambda t: t[1], reverse=True),
          list(reversed(sorted(data, key=lambda t: t[1]))))
result
""",
    # list.sort is in place and returns None; sorted returns a new list
    """
l = [3, 1, 2]
r = l.sort()
s = sorted([3, 1, 2])
result = (l, r, s)
result
""",
    # the sort key is computed exactly once per element
    """
calls = []
def key(x):
    calls.append(x)
    return -x
out = sorted([3, 1, 2], key=key)
result = (out, sorted(calls), len(calls))
result
""",
    # sorting strings is by code point, so uppercase sorts before lowercase
    """
result = (sorted(['b', 'A', 'a', 'B']), sorted(['10', '9', '1']),
          sorted([True, False]), max('apple'))
result
""",
    # min/max with a key return the first extreme element
    """
data = [('a', 1), ('b', 1), ('c', 0)]
result = (max(data, key=lambda t: t[1]), min(data, key=lambda t: t[1]),
          max([], default='none'))
result
""",
    # enumerate start, reversed, zip of unequal lengths
    """
result = (list(enumerate('ab', 10)), list(reversed([1, 2, 3])),
          list(zip('abc', [1, 2])), list(zip()))
result
""",
    # range is lazy, supports negative indexing and slices to a range
    # (RustPython #877 returned -1 for range(10)[-1])
    """
r = range(10)
result = (r[-1], r[2], list(r[1:4]), type(r[1:4]).__name__, len(range(0, 10, 3)),
          list(range(5, 0, -2)), list(range(0, 10, -1)))
result
""",
    # range equality is by VALUE SEQUENCE, not by parameters
    """
result = (range(0, 3) == range(0, 3), range(0) == range(2, 2, 3),
          range(0, 3, 2) == range(0, 4, 2), 3 in range(0, 10, 3))
result
""",
    # tuple slicing yields a tuple; a 1-element tuple needs the comma
    """
result = ((1, 2, 3)[1:], type((1,)).__name__, type((1)).__name__,
          len(()), (1,) + (2,))
result
""",
    # bytes index to int, bytes slice to bytes
    """
b = b'abc'
result = (b[0], b[0:1], type(b[0]).__name__, list(b), bytes([104, 105]))
result
""",
    # bytearray is mutable and its slice assignment can resize
    """
ba = bytearray(b'abc')
ba[1:2] = b'XY'
ba[0] = 122
result = (bytes(ba), len(ba))
result
""",
    # frozenset/set operations, made deterministic by sorting
    """
a = {1, 2, 3}
b = {3, 4}
result = (sorted(a | b), sorted(a & b), sorted(a - b), sorted(a ^ b),
          a.issubset({1, 2, 3, 4}), len({1, 1, 1}))
result
""",
    # list/tuple/str multiplication and concatenation identity
    """
a = []
b = a * 1
c = a + []
result = (a == b, a is b, a is c, ('x' * 1) == 'x')
result
""",
    # ------------------------------------------------------------------
    # 17. STRUCTURAL PATTERN MATCHING -- ref 8.6, PEP 634, test_patma.py.
    # [3.10+]
    # ------------------------------------------------------------------
    # capture patterns bind, and the binding OUTLIVES the match (ref 8.6)
    """
def f(v):
    match v:
        case 0:
            r = 'zero'
        case [x, y]:
            r = ('pair', x, y)
        case {'k': k}:
            r = ('map', k)
        case other:
            r = ('other', other)
    return r
result = (f(0), f([1, 2]), f({'k': 9, 'extra': 1}), f('z'))
result
""",
    # str/bytes NEVER match a sequence pattern (ref 8.6.4.8)
    """
def f(v):
    match v:
        case [a, b]:
            return ('seq', a, b)
        case str() as s:
            return ('str', s)
        case _:
            return 'none'
result = (f('ab'), f(['a', 'b']), f(('a', 'b')), f(b'ab'))
result
""",
    # mapping patterns match a SUBSET of keys and ignore extras (ref 8.6.4.9)
    """
def f(d):
    match d:
        case {'a': a}:
            return ('has-a', a)
        case {}:
            return 'any-mapping'
        case _:
            return 'no-match'
result = (f({'a': 1, 'b': 2}), f({'b': 2}), f({}), f([]))
result
""",
    # **rest collects only the UNMATCHED keys
    """
match {'a': 1, 'b': 2, 'c': 3}:
    case {'a': a, **rest}:
        result = (a, rest)
result
""",
    # a mapping pattern must not trigger __missing__ / must use two-arg get
    """
log = []
class D(dict):
    def __missing__(self, k):
        log.append(k)
        return 0
d = D()
match d:
    case {0: 0}:
        r = 'matched'
    case _:
        r = 'no-match'
result = (r, dict(d), log)
result
""",
    # literal True/False/None use `is`, so 0 does not match False (ref 8.6.4.3)
    """
def f(v):
    match v:
        case False:
            return 'False'
        case True:
            return 'True'
        case None:
            return 'None'
        case 0:
            return 'zero'
        case 1:
            return 'one'
        case _:
            return 'other'
result = (f(0), f(1), f(False), f(True), f(None), f(0.0))
result
""",
    # a star subpattern always binds a LIST, in any position
    """
def f(v):
    match v:
        case [0, *mid, 2]:
            return ('mid', mid)
        case [*all_]:
            return ('all', all_)
    return None
result = (f((0, 1, 1, 2)), f(range(3)), f([]), f((0, 2)))
result
""",
    # class patterns use __match_args__ FROM THE CLASS NAMED IN THE PATTERN
    # (test_patma.py test_patma_202/203)
    """
class Parent:
    __match_args__ = ('a', 'b')
    def __init__(self):
        self.a, self.b, self.c = 1, 2, 3
class Child(Parent):
    __match_args__ = ('c', 'b')
match Child():
    case Parent(x, y):
        result = ('parent-args', x, y)
    case _:
        result = 'no'
result
""",
    # positional and keyword subpatterns can be mixed
    """
class P:
    __match_args__ = ('x', 'y')
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z
match P(1, 2, 3):
    case P(a, z=c):
        result = (a, c)
result
""",
    # the 11 special-cased builtins treat a single positional subpattern as
    # matching the WHOLE subject (ref 8.6.4.10)
    """
def f(v):
    match v:
        case int(n):
            return ('int', n)
        case str(s):
            return ('str', s)
        case list(l):
            return ('list', l)
    return 'other'
result = (f(5), f('x'), f([1]), f(2.5), f(True))
result
""",
    # guards are evaluated in order, only for patterns that already matched,
    # and stop at the first selected block (ref 8.6.2, test_patma_252)
    """
effects = []
def lt(x, n):
    effects.append((x, n))
    return x < n
match {'foo': 1}:
    case {'foo': x} if lt(x, 0):
        res = 0
    case {'foo': x} if lt(x, 1):
        res = 1
    case {'foo': x} if lt(x, 2):
        res = 2
result = (res, effects)
result
""",
    # or-patterns are tried left to right and every alternative binds the
    # same names (ref 8.6.4.1)
    """
def f(v):
    match v:
        case [x] | x:
            return x
result = (f(1), f([1]), f([[2]]))
result
""",
    # a VALUE pattern needs a dotted name; a bare name is always a capture
    # (ref 8.6.4.6)
    """
class Cfg:
    LIMIT = 10
LIMIT = 99
def f(v):
    match v:
        case Cfg.LIMIT:
            return 'value-pattern'
        case LIMIT:
            return ('capture', LIMIT)
result = (f(10), f(3), LIMIT)
result
""",
    # `as` inside a sequence pattern binds the whole element
    """
match [[1, 2], [3, 4]]:
    case [[a, b], [c, d] as whole]:
        result = (a, b, c, d, whole)
result
""",
    # bindings from earlier failed guards persist (test_patma_009)
    """
class A:
    B = 0
match 0:
    case x if x:
        z = 0
    case _ as y if y == x and y:
        z = 1
    case A.B:
        z = 2
result = (x, y, z)
result
""",
    # sequence patterns use __len__ then __getitem__ (test_patma_184/186)
    """
class Seq:
    def __len__(self):
        return 4
    def __getitem__(self, i):
        return i * 11
match Seq():
    case [a, *_, b]:
        result = (a, b)
    case _:
        result = 'no'
result
""",
    # a match that binds nothing leaves no names behind (test_patma_204)
    """
def f(v):
    match v:
        case 42:
            pass
    return sorted(k for k in locals() if k != 'v')
result = f(42)
result
""",
    # `match` and `case` are SOFT keywords and remain usable as names
    # (ref 2.3.2)
    """
match = 1
case = 2
def f(x):
    return x + match + case
result = (f(0), match, case)
result
""",
    # ------------------------------------------------------------------
    # 18. DECORATORS -- ref 8.7/8.8.
    # smolagents ignores decorator_list entirely: `@property` silently
    # returns a bound method.
    # ------------------------------------------------------------------
    # decorator expressions are evaluated TOP DOWN, then applied BOTTOM UP
    """
log = []
def mk(n):
    log.append('eval' + n)
    def deco(f):
        log.append('apply' + n)
        return f
    return deco
@mk('1')
@mk('2')
def fn():
    return 'base'
result = (log, fn())
result
""",
    # the composition order: @d1 @d2 def f  ==  f = d1(d2(f))
    """
def d1(f):
    return lambda: 'd1(' + f() + ')'
def d2(f):
    return lambda: 'd2(' + f() + ')'
@d1
@d2
def fn():
    return 'base'
result = fn()
result
""",
    # a decorator can replace the function entirely, and the name is never
    # bound to the undecorated function
    """
def replace(f):
    return 'NOT-A-FUNCTION'
@replace
def fn():
    return 'never'
result = (fn, callable(fn))
result
""",
    # class decorators
    """
def tag(cls):
    cls.tagged = True
    return cls
@tag
class C:
    pass
result = (C.tagged, C.__name__)
result
""",
    # a parameterised decorator closes over its argument
    """
def repeat(n):
    def deco(f):
        def wrapper(*a):
            return [f(*a) for _ in range(n)]
        return wrapper
    return deco
@repeat(3)
def one():
    return 1
result = one()
result
""",
    # ------------------------------------------------------------------
    # 19. EVALUATION ORDER -- ref 6.16.
    # RustPython #5566 evaluates all expressions before unpacking.
    # ------------------------------------------------------------------
    # arguments are evaluated left to right, before the call
    """
log = []
def a():
    log.append('a')
    return 1
def b():
    log.append('b')
    return 2
def f(*args, **kw):
    log.append('call')
    return (args, kw)
v = f(a(), k=b())
result = (v, log)
result
""",
    # a dict display evaluates key BEFORE value, pair by pair [3.8+]
    """
log = []
def k(n):
    log.append('k' + n)
    return n
def v(n):
    log.append('v' + n)
    return n
d = {k('1'): v('1'), k('2'): v('2')}
result = (d, log)
result
""",
    # a dict COMPREHENSION also evaluates key before value [3.8+]
    """
log = []
def k(n):
    log.append('k' + str(n))
    return n
def v(n):
    log.append('v' + str(n))
    return n
d = {k(i): v(i) for i in range(2)}
result = (d, log)
result
""",
    # unpacking in a display is interleaved left to right with the plain
    # elements (RustPython #5566)
    """
log = []
class Noisy:
    def __iter__(self):
        log.append('iter')
        return iter(['N'])
def arg():
    log.append('arg')
    return 'A'
lst = [*Noisy(), arg()]
result = (lst, log)
result
""",
    # the same, in a call
    """
log = []
class Noisy:
    def __iter__(self):
        log.append('iter')
        return iter(['N'])
def arg():
    log.append('arg')
    return 'A'
def sink(*a):
    return a
v = sink(*Noisy(), arg())
result = (v, log)
result
""",
    # a subscript primary is evaluated before the subscript expression
    """
log = []
def container():
    log.append('container')
    return [10, 20]
def index():
    log.append('index')
    return 1
v = container()[index()]
result = (v, log)
result
""",
    # ------------------------------------------------------------------
    # 20. BUILTINS AND MISCELLANY
    # ------------------------------------------------------------------
    # isinstance/issubclass with tuples, and bool vs int
    """
result = (isinstance(True, int), isinstance(1, bool), issubclass(bool, int),
          isinstance('a', (int, str)), isinstance([], (tuple, list)))
result
""",
    # type() vs isinstance() for subclasses
    """
class L(list):
    pass
l = L()
result = (isinstance(l, list), type(l) is list, type(l) is L,
          L() == [], type(L() + []).__name__)
result
""",
    # str/repr of containers uses repr on the elements, recursively
    """
result = (repr(['a', ('b',), {'c': 'd'}]), str([1.0, 2]),
          repr((1,)), repr({}), repr(set()))
result
""",
    # a list subclass loses its type through most operations
    """
class L(list):
    pass
l = L([1, 2])
result = (type(l + [3]).__name__, type(l[:1]).__name__,
          type(l * 2).__name__, type(sorted(l)).__name__)
result
""",
    # int/str subclass round trips
    """
class S(str):
    pass
s = S('ab')
result = (type(s.upper()).__name__, type(s + 'c').__name__, s == 'ab',
          type(str(s)).__name__)
result
""",
    # `vars`/`dir` on an instance vs a class
    """
class C:
    cls_attr = 1
    def __init__(self):
        self.inst_attr = 2
c = C()
result = (vars(c), 'cls_attr' in dir(c), 'inst_attr' in dir(c),
          'cls_attr' in vars(c))
result
""",
    # getattr/setattr/hasattr/delattr with defaults
    """
class C:
    pass
c = C()
setattr(c, 'x', 1)
before = hasattr(c, 'x')
delattr(c, 'x')
result = (before, hasattr(c, 'x'), getattr(c, 'x', 'DFLT'))
result
""",
    # callable(), and a class is callable
    """
class C:
    pass
result = (callable(C), callable(C()), callable(len), callable(1),
          callable(lambda: 1))
result
""",
    # id-free identity: `is` on the SAME object, and `==` on equal ones
    """
a = [1]
b = [1]
c = a
result = (a == b, a is b, a is c, None is None, () is ())
result
""",
    # a function's __name__, __qualname__, __defaults__ and __doc__
    """
def outer():
    def inner(a, b=2):
        'the doc'
        return a
    return inner
f = outer()
result = (f.__name__, f.__qualname__.endswith('outer.<locals>.inner'),
          f.__defaults__, f.__doc__)
result
""",
    # *args / **kwargs collection and keyword-only parameters
    """
def f(a, *args, kw, **kwargs):
    return (a, args, kw, kwargs)
result = f(1, 2, 3, kw=4, extra=5)
result
""",
    # positional-only parameters [3.8+]
    """
def f(a, /, b, *, c):
    return (a, b, c)
err = None
try:
    f(a=1, b=2, c=3)
except TypeError:
    err = 'TypeError'
result = (f(1, 2, c=3), f(1, b=2, c=3), err)
result
""",
    # a default of None distinguished from an omitted argument
    """
sentinel = object()
def f(x=sentinel):
    return 'omitted' if x is sentinel else ('given', x)
result = (f(), f(None), f(0))
result
""",
    # `del` on a name, an item and a slice (ref 7.5)
    """
d = {'a': 1, 'b': 2}
l = [0, 1, 2, 3]
x = 5
del d['a']
del l[1:3]
del x
result = (d, l, 'x' in dir())
result
""",
    # exec/eval with an explicit namespace do not touch the enclosing one
    """
ns = {}
exec('a = 1 + 1', ns)
v = eval('a * 3', ns)
result = (ns['a'], v, 'a' in dir())
result
""",
    # a walrus in a while condition
    """
src = [3, 2, 1, 0]
out = []
i = 0
while (n := src[i]) > 0:
    out.append(n)
    i += 1
result = (out, n)
result
""",
    # a walrus inside an if, and inside a call argument
    """
data = [1, 2, 3]
if (total := sum(data)) > 5:
    tag = 'big'
else:
    tag = 'small'
lengths = [len(chunk) for line in ['ab', 'cde'] if (chunk := line * 2)]
result = (total, tag, lengths, chunk)
result
""",
    # a ternary chain and operator precedence without parentheses
    """
result = (1 + 2 * 3 ** 2, (1 + 2) * 3, not True == False,
          1 if 0 else 2 if 1 else 3, True + 1 if False else 'x')
result
""",
    # a class attribute shared by all instances until shadowed
    """
class C:
    shared = []
    count = 0
a = C()
b = C()
a.shared.append(1)
a.count += 1
result = (b.shared, C.count, a.count, 'count' in a.__dict__)
result
""",
    # private name mangling uses the innermost enclosing class (ref 2.3.3)
    """
class C:
    __x = 1
    def get(self):
        return self.__x
result = (C().get(), '_C__x' in C.__dict__, '__x' in C.__dict__)
result
""",
    # mangling applies to any identifier starting with two underscores and
    # ending in at most one, inside a class body
    """
class C:
    def f(self):
        return [n for n in ('__a', '__b__', '_c') ]
class D:
    __a = 1
    __b__ = 2
    _c = 3
result = sorted(k for k in D.__dict__ if 'a' in k or 'b' in k or 'c' in k)
result
""",
)


RAISING_CORPUS: tuple[str, ...] = (
    # ------------------------------------------------------------------
    # SCOPING ERRORS -- ref 4.2.2. A name bound ANYWHERE in a block is local
    # for the WHOLE block, so the read before the assignment fails rather
    # than falling through to the global. smolagents happily returns the
    # global (or 0, for augassign).
    # ------------------------------------------------------------------
    # UnboundLocalError: read before the (later) local assignment
    """
x = 'global'
def f():
    v = x
    x = 'local'
    return v
result = f()
result
""",
    # `del` is a binding operation, so it makes the name local (ref 4.2.1)
    # -- RustPython #4910 silently deleted the global instead
    """
l = 'global'
def f():
    del l
f()
result = l
result
""",
    # augmented assignment to a global without `global` is UnboundLocalError
    # (test_scope.py testUnboundLocal_AugAssign). smolagents returns 5 here.
    """
counter = 10
def f():
    counter += 1
    return counter
result = f()
result
""",
    # a free variable never bound anywhere gives NameError, not
    # UnboundLocalError (test_scope.py testUnboundLocal)
    """
def outer():
    def inner():
        return y
    return inner()
result = outer()
result
""",
    # a comprehension in a class body cannot see class-body names
    # (ref 4.2.2; test_listcomps.py test_name_error_in_class_scope)
    """
class C:
    y = 1
    vals = [x + y for x in range(2)]
result = C.vals
result
""",
    # the comprehension target does not survive the comprehension
    """
[q for q in range(3)]
result = q
result
""",
    # `nonlocal` with no binding in any enclosing function is a SyntaxError
    # (compile time, ref 7.13)
    """
def f():
    nonlocal nothing_here
    return 1
result = f()
result
""",
    # ------------------------------------------------------------------
    # UNPACKING ERRORS -- test_unpack_ex.py
    # ------------------------------------------------------------------
    # too many values: ValueError, not a silent truncation
    """
a, b = [1, 2, 3]
result = (a, b)
result
""",
    # too few values with a star target: the message says "at least"
    """
a, b, c, *d = [1, 2]
result = (a, b, c, d)
result
""",
    # unpacking a non-iterable is a TypeError, not a ValueError
    """
a, *b = 7
result = (a, b)
result
""",
    # two starred targets in one target list is a SyntaxError
    """
a, *b, *c = [1, 2, 3]
result = (a, b, c)
result
""",
    # an exception raised by __getitem__ while probing past the end
    # propagates unchanged, it is NOT converted to a ValueError
    """
class Bad:
    def __getitem__(self, i):
        if i == 2:
            raise KeyError('probe')
        return i
a, b, c = Bad()
result = (a, b, c)
result
""",
    # extended-slice assignment requires an exactly matching length
    """
l = [0, 1, 2, 3, 4, 5]
l[::2] = [9, 9]
result = l
result
""",
    # duplicate keyword through ** unpacking
    """
def f(x):
    return x
result = f(x=5, **{'x': 3})
result
""",
    # `{**obj}` needs keys() and __getitem__
    """
result = {**[1, 2]}
result
""",
    # ------------------------------------------------------------------
    # AUGMENTED ASSIGNMENT ERRORS
    # ------------------------------------------------------------------
    # an unpacking target cannot be augmented (ref 7.2.1) -- SyntaxError
    """
x = 1
b = 2
x, b += 3
result = (x, b)
result
""",
    # __iadd__ = None blocks BOTH inheritance and the __add__ fallback
    # (ref 3.3.1; test_augassign.py aug_test4)
    """
class Base:
    def __add__(self, o):
        return 'added'
class Blocked(Base):
    __iadd__ = None
x = Blocked()
x += 1
result = x
result
""",
    # tuples do not support item assignment (even though `t[0] += ...`
    # mutates a mutable element first -- see the SEMANTIC counterpart)
    """
t = (1, 2)
t[0] += 1
result = t
result
""",
    # ------------------------------------------------------------------
    # DATA MODEL ERRORS
    # ------------------------------------------------------------------
    # defining __eq__ without __hash__ sets __hash__ = None (ref 3.3.1)
    """
class E:
    def __eq__(self, o):
        return True
result = {E(): 1}
result
""",
    # implicit special-method lookup bypasses the instance dict (ref 3.3.13)
    """
class C:
    pass
c = C()
c.__len__ = lambda: 4
result = len(c)
result
""",
    # __slots__ blocks arbitrary attributes
    """
class S:
    __slots__ = ('a',)
s = S()
s.b = 1
result = s.b
result
""",
    # a function in the instance dict is not bound, so `self` is missing
    """
class C:
    pass
c = C()
c.f = lambda self: self
result = c.f()
result
""",
    # __int__ does not satisfy an index requirement (ref 3.3.8)
    """
class Num:
    def __int__(self):
        return 1
result = [10, 20][Num()]
result
""",
    # __index__ must return an int
    """
class Bad:
    def __index__(self):
        return 'not-an-int'
result = [1, 2, 3][Bad()]
result
""",
    # an inconsistent MRO cannot be linearised (C3)
    """
class A:
    pass
class B(A):
    pass
class C(A, B):
    pass
result = C
result
""",
    # [].__add__ with a wrong type raises rather than returning
    # NotImplemented (PyPy returns NotImplemented here)
    """
result = [].__add__(None)
result
""",
    # __exit__ set on the INSTANCE is ignored: the protocol is looked up on
    # the type (ref 8.5; test_contextlib.py test_instance_bypass)
    """
class M:
    pass
m = M()
m.__enter__ = lambda: 'v'
m.__exit__ = lambda *a: False
with m as v:
    pass
result = v
result
""",
    # ------------------------------------------------------------------
    # GENERATOR ERRORS
    # ------------------------------------------------------------------
    # PEP 479: a StopIteration escaping a generator body becomes RuntimeError
    """
def gen():
    yield 1
    raise StopIteration('boom')
result = list(gen())
result
""",
    # send(non-None) to a not-yet-started generator is a TypeError (ref 6.2.10)
    """
def gen():
    yield 1
g = gen()
result = g.send(5)
result
""",
    # a generator that yields again after GeneratorExit gets RuntimeError
    """
def gen():
    try:
        yield 1
    except GeneratorExit:
        yield 2
g = gen()
next(g)
g.close()
result = 'closed'
result
""",
    # `yield` outside a function is a SyntaxError
    """
result = [(yield 1)]
result
""",
    # `return` with a value in an async generator is a SyntaxError (ref 7.6)
    """
async def agen():
    yield 1
    return 5
result = agen
result
""",
    # ------------------------------------------------------------------
    # PATTERN MATCHING ERRORS -- test_patma.py TestTypeErrors/TestValueErrors
    # ------------------------------------------------------------------
    # a class without __match_args__ rejects positional subpatterns
    """
class C:
    def __init__(self):
        self.a = 1
match C():
    case C(x):
        result = x
result
""",
    # __match_args__ containing a non-str entry is a TypeError
    """
class C:
    __match_args__ = (None,)
match C():
    case C(x):
        result = x
    case _:
        result = 'no'
result
""",
    # the pattern head must be a class
    """
match 1:
    case max(0, 1):
        result = 'matched'
result
""",
    # `case {**_}` is a SyntaxError
    """
match {}:
    case {**_}:
        result = 'x'
result
""",
    # ------------------------------------------------------------------
    # EXCEPTION / CONTROL FLOW ERRORS
    # ------------------------------------------------------------------
    # `except ... as N` deletes N, so reading it afterwards fails even if it
    # was bound before the try (ref 8.4.1). NameError at module scope...
    """
e = 'before'
try:
    1 / 0
except Exception as e:
    pass
result = e
result
""",
    # ...and UnboundLocalError inside a function, where e is statically local
    """
def f():
    e = 'before'
    try:
        1 / 0
    except Exception as e:
        pass
    return e
result = f()
result
""",
    # a bare `raise` with no active exception is a RuntimeError (ref 7.8)
    """
raise
result = 'unreached'
result
""",
    # ExceptionGroup rejects a BaseException leaf (test_exception_group.py)
    """
result = ExceptionGroup('g', [ValueError(1), KeyboardInterrupt(2)])
result
""",
    # an ExceptionGroup must be constructed from a non-empty SEQUENCE
    """
result = ExceptionGroup('g', {ValueError(1)})
result
""",
    # `break`/`continue`/`return` are forbidden inside an except* clause
    # (ref 8.4.2) -- SyntaxError
    """
for i in range(1):
    try:
        raise ExceptionGroup('g', [ValueError()])
    except* ValueError:
        break
result = 'done'
result
""",
    # ------------------------------------------------------------------
    # STRING / NUMBER ERRORS
    # ------------------------------------------------------------------
    # splitting on the empty separator is a ValueError
    """
result = 'abc'.split('')
result
""",
    # %-formatting with a bare tuple consumes the elements as arguments
    """
result = '%s' % (1, 2)
result
""",
    # mixing str and bytes in implicit concatenation is a SyntaxError (ref 2.5)
    """
result = 'a' b'b'
result
""",
    # a leading zero in a nonzero decimal literal is a SyntaxError (ref 2.6.1)
    """
result = 0123
result
""",
    # str + int is a TypeError, never a coercion
    """
result = 'a' + 1
result
""",
    # ordering comparison between dicts is undefined (ref 6.10.1)
    """
result = {1: 2} < {3: 4}
result
""",
    # ordering comparison between incomparable types
    """
result = sorted([1, 'a'])
result
""",
    # int('1', 0) style: a base-prefixed string with a redundant leading zero
    """
result = int('010', 0)
result
""",
    # pow with a negative exponent and a non-coprime modulus
    """
result = pow(4, -1, 8)
result
""",
    # 0 ** -1 is a ZeroDivisionError
    """
result = 0 ** -1
result
""",
)


# --------------------------------------------------------------------------
# CPython IMPLEMENTATION DETAILS.
#
# Every snippet here is also in SEMANTIC_CORPUS and runs deterministically on
# CPython, but the Language Reference does NOT guarantee the answer. Keep them
# when the target re-implementation runs ON CPython objects (smolagents-style
# AST walkers, RestrictedPython, Skulpt-in-CPython harnesses); DROP them when
# the target is RustPython, PyPy, Brython or Jython, where they are expected
# false positives.
#
#   * PyPy makes `x + 1 is x + 1` True for arbitrary ints and
#     `float('nan') is float('nan')` True.
#   * PyPy's instance __dict__ does not preserve __init__ assignment order.
#   * Brython has `0.1 is 0.1` False.
# --------------------------------------------------------------------------
IMPLEMENTATION_DEFINED: tuple[str, ...] = (
    # small-int caching: CPython interns -5..256, so `is` holds there and
    # generally does not above it. NOT guaranteed by the language.
    """
a = 256
b = 256
c = 257
d = 257
e = -5
f = -5
result = (a is b, c is d, e is f, 1000 is not None)
result
""",
    # compile-time constant folding puts equal literals in one code object's
    # co_consts, so `is` holds inside a single expression but not across
    # separately-built values
    """
x = 1000
y = 1000
def make():
    return 1000
result = (x is y, x == y, make() is make(), x == make())
result
""",
    # string interning: identifier-like literals are interned, built ones
    # generally are not
    """
a = 'hello'
b = 'hello'
c = ''.join(['hel', 'lo'])
result = (a is b, a is c, a == c, ('a' 'b') is 'ab')
result
""",
    # the empty tuple and empty frozenset are singletons in CPython
    """
result = (() is (), tuple() is (), frozenset() is frozenset(),
          [] is not [])
result
""",
    # each `float('nan')` is a distinct object in CPython, so a set can hold
    # several. PyPy caches floats by value and holds only one.
    """
a = float('nan')
b = float('nan')
result = (a is b, len({a, b}), len({a, a}), a != a)
result
""",
)


# --------------------------------------------------------------------------
# DELIBERATELY EXCLUDED.
#
# Each entry is (snippet_sketch, reason). These would produce flaky or
# meaningless diffs and are NOT part of either corpus. Documented so the
# exclusion is a decision, not an oversight.
# --------------------------------------------------------------------------
EXCLUDED_UNSAFE: tuple[tuple[str, str], ...] = (
    (
        "result = list({'b', 'a', 'c'})",
        "set and frozenset iteration order depends on hash values and insertion "
        "history; str hashing is randomised per process by PYTHONHASHSEED, so "
        "this differs BETWEEN CPYTHON RUNS. Always sort() a set before "
        "comparing. (ref: set is unordered; PEP 456 / -R hash randomisation, "
        "which PyPy ignores entirely.)",
    ),
    (
        "result = hash('abc')",
        "str/bytes hashing is salted per process (PEP 456). Only hashes of "
        "int/float/bool/None are stable, and only their EQUALITY relations are "
        "specified.",
    ),
    (
        "result = id(x) < id(y)",
        "id() is an arbitrary address in CPython and a computed value in PyPy "
        "that can exceed sys.maxsize. Never observable.",
    ),
    (
        "class C:\\n    def __del__(self): log.append('gone')\\nc = C(); del c",
        "finalisation TIMING is refcount-dependent. CPython frees immediately; "
        "PyPy/Jython defer to a GC pass and may never run __del__ within the "
        "snippet. Also: PyPy calls __del__ on cycle members, CPython puts them "
        "in gc.garbage.",
    ),
    (
        "result = sys.getrefcount(x)",
        "requires an import, and PyPy raises AttributeError for it. Refcounts "
        "are a CPython-only concept.",
    ),
    (
        "s = ''\\nfor i in range(100000): s += 'x'\\nresult = len(s)",
        "correct everywhere but O(n) in CPython (the refcount==1 realloc trick) "
        "and O(n^2) in PyPy. A performance divergence that becomes a timeout, "
        "not a value divergence.",
    ),
    (
        "result = str(0.1 * 3)",
        "SAFE on any IEEE-754 double implementation and IS included in the "
        "corpus, but excluded in the specific form 'compare float repr across "
        "a JS-backed implementation' -- Brython/Skulpt box floats as JS numbers "
        "and their repr shortest-round-trip algorithm differs. Compare with a "
        "tolerance instead if the target is JS-hosted.",
    ),
    (
        "result = 'ﬁ'.isidentifier()",
        "identifiers are NFKC-normalised at PARSE time only, so source-level "
        "and runtime answers diverge in ways that depend on the Unicode "
        "database version bundled with the implementation.",
    ),
    (
        "result = '\\u180e'.isspace()",
        "the Unicode database VERSION differs between implementations; PyPy "
        "issue #5369 documents str.split treating U+180E as whitespace where "
        "CPython does not. Restrict to ASCII, or to characters whose class has "
        "been stable for a decade.",
    ),
    (
        "result = str(e) for a builtin exception e",
        "exception MESSAGE TEXT is explicitly not API (ref 4.3 note). Compare "
        "type(e).__name__ and e.args, never str(e), for builtin exceptions. "
        "The corpus follows this rule throughout.",
    ),
    (
        "class Keys: KEY = 'a'\\nmatch {'a': 0}:\\n    case {Keys.KEY: y, 'a': z}: ...",
        "test_patma.py TestValueErrors expects a runtime ValueError for a "
        "duplicate mapping key where one side is a value pattern. Verified on "
        "CPython 3.14: the match simply FAILS and no ValueError is raised. The "
        "behaviour is version-sensitive, so it is in neither corpus.",
    ),
    (
        "match x:\\n    case [a, b] if False: pass\\nresult = a",
        "ref 8.6 states bindings after a FAILED match are intentionally "
        "implementation-defined. Only successful-match bindings are asserted.",
    ),
    (
        "result = sys.getsizeof([])",
        "PyPy raises TypeError for __sizeof__ unconditionally; sizes are "
        "meaningless across implementations.",
    ),
    (
        "import threading / time / random / open(...)",
        "any concurrency, clock, entropy or filesystem access makes the "
        "comparison non-reproducible even against CPython itself.",
    ),
    (
        "result = [f_locals behaviour inside a comprehension]",
        "CPython 3.13's FrameLocalsProxy makes `'a' in f_locals` False while "
        "f_locals['a'] == 0 inside a comprehension (test_listcomps.py "
        "test_frame_locals). Version-specific CPython quirk.",
    ),
    (
        "result = __builtins__",
        "a module in PyPy, a dict in CPython when running inside a module. "
        "ref 4.2.5 declares it an implementation detail.",
    ),
    (
        "result = type(f()).__name__ for a very deep recursion",
        "sys.setrecursionlimit is approximate in PyPy (n * 768 bytes of stack), "
        "so the depth at which RecursionError fires is not portable. Brython "
        "raises spurious RecursionErrors (#2411).",
    ),
    (
        "result = (2).__add__.__class__.__name__",
        "PyPy exposes builtin methods as ordinary method objects rather than "
        "method-wrapper/slot wrapper, so inspect.ismethod and the type name "
        "differ. Test the BEHAVIOUR of the operator, not the wrapper type.",
    ),
    (
        "result = list(C().__dict__) after out-of-order __init__ assignment",
        "PyPy uses hidden-class maps, so instance __dict__ does not preserve "
        "the order in which __init__ assigned the attributes. The MODULE-level "
        "and CLASS-level dict order guarantees ARE specified and are tested; "
        "instance-dict order is not.",
    ),
    (
        "result = eval('x', D()) with a dict subclass namespace",
        "PyPy calls the overridden __getitem__ of a dict subclass used as a "
        "namespace where CPython bypasses it (documented in "
        "cpython_differences). Behaviour of exec/eval with a mapping subclass "
        "is not portable.",
    ),
    (
        "async def / await snippets driven by a real event loop",
        "needs an import (asyncio) and a scheduler. Coroutine SEMANTICS can be "
        "tested synchronously via generators, which is what this corpus does; "
        "an actual await needs a runtime and is excluded.",
    ),
)


__all__ = [
    "SEMANTIC_CORPUS",
    "RAISING_CORPUS",
    "IMPLEMENTATION_DEFINED",
    "EXCLUDED_UNSAFE",
]
