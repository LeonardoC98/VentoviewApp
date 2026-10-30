# Ventoview: führt den Python-Code eines eigenen Keywords aus (gestartet von core/keywords.js).
# Eingabe (stdin, JSON): code, key, vars, store, full. Ausgabe (stdout, JSON): value, store.
# Alle Variablen stehen unter ihrem Namen bereit (und in „variablen“), „speicher“ bleibt zwischen den Läufen erhalten.
#
# Sicherer Modus (Standard, full = false): nur Rechnen, Text, Listen und ein paar harmlose Module. Kein Dateizugriff,
# keine Programme, kein Netzwerk, kein Zugriff auf Python-Interna („_…“). Das schützt vor Versehen und einfachem
# fremdem Code – ein echter Käfig ist es nicht, darum bleibt „voller Zugriff“ eine bewusste Entscheidung.
import ast
import builtins
import contextlib
import io
import json
import sys
import types

data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
key = data["key"]
full = bool(data.get("full"))

SAFE_MODULES = {
    "math", "cmath", "random", "statistics", "datetime", "time", "json", "re", "decimal", "fractions",
    "itertools", "collections", "functools", "string", "textwrap", "calendar", "operator", "bisect", "heapq",
}
BLOCKED = {
    "open", "eval", "exec", "compile", "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr",
    "__import__", "input", "breakpoint", "help", "exit", "quit", "memoryview", "object", "type", "super",
    "classmethod", "staticmethod", "property", "__builtins__", "__loader__", "__spec__",
}


# Platzhalter in .format() dürfen auf Interna zugreifen („{0.__class__}“) – dafür gibt es f-Strings
FORMAT_ATTRS = {"format", "format_map", "vformat", "get_field"}


class Gesperrt(Exception):
    pass


def check(code):
    tree = ast.parse(code, "<" + key + ">")
    for node in ast.walk(tree):
        line = getattr(node, "lineno", None)
        where = f" (Zeile {line})" if line else ""
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in SAFE_MODULES:
                    raise Gesperrt(f"import {alias.name} ist im sicheren Modus nicht erlaubt{where}")
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] not in SAFE_MODULES or node.level:
                raise Gesperrt(f"from {node.module} import … ist im sicheren Modus nicht erlaubt{where}")
        elif isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in FORMAT_ATTRS):
            raise Gesperrt(f"„.{node.attr}“ ist im sicheren Modus nicht erlaubt – nimm f-Strings: f\"{{wert}}\"{where}")
        elif isinstance(node, ast.Name) and (node.id in BLOCKED or node.id.startswith("__")):
            raise Gesperrt(f"„{node.id}“ ist im sicheren Modus nicht erlaubt{where}")
        elif isinstance(node, (ast.Global, ast.Nonlocal)) and any(n.startswith("__") for n in node.names):
            raise Gesperrt(f"Das ist im sicheren Modus nicht erlaubt{where}")


def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name.split(".")[0] not in SAFE_MODULES:
        raise Gesperrt(f"import {name} ist im sicheren Modus nicht erlaubt")
    module = __import__(name, globals, locals, fromlist, level)
    # Nur Funktionen, Klassen und Werte des Moduls – keine anderen Module (z. B. datetime.sys)
    return types.SimpleNamespace(**{k: v for k in dir(module) if not k.startswith("_")
                                    for v in [getattr(module, k)] if not isinstance(v, types.ModuleType)})


def wert(v):
    # Zahlen als Zahlen: "42" → 42, "3,5" → 3.5
    if isinstance(v, str):
        t = v.strip()
        if t.count(",") == 1 and "." not in t:
            t = t.replace(",", ".")
        try:
            return int(t)
        except ValueError:
            pass
        try:
            f = float(t)
            if f == f and abs(f) != float("inf"):
                return f
        except ValueError:
            pass
    return v


variablen = {k: wert(v) for k, v in data["vars"].items()}
g = {"__name__": "__ventoview__", "variablen": variablen, "speicher": data.get("store") or {}}
for k, v in variablen.items():
    if k.isidentifier() and not k.startswith("_"):
        g[k] = v

if not full:
    try:
        check(data["code"])
    except Gesperrt as err:
        sys.stderr.write(f"Gesperrt: {err}\n")
        sys.exit(2)
    safe = {k: v for k, v in vars(builtins).items() if k not in BLOCKED and not k.startswith("_")}
    safe["__import__"] = safe_import
    safe["__build_class__"] = builtins.__build_class__
    g["__builtins__"] = safe

out = io.StringIO()
with contextlib.redirect_stdout(out):
    exec(compile(data["code"], "<" + key + ">", "exec"), g)

found = None
for k, v in g.items():
    if k.lower() == key and k not in ("variablen", "speicher"):
        found = v
if found is None:
    for k in ("ergebnis", "result"):
        if k in g:
            found = g[k]
if found is None:
    found = out.getvalue().strip()
if isinstance(found, bool):
    found = "ja" if found else "nein"
elif isinstance(found, float):
    found = round(found, 4)
    found = int(found) if found.is_integer() else found
if isinstance(found, (dict, list)):
    text = json.dumps(found, ensure_ascii=False, default=str)
else:
    text = str(found)
try:
    store = json.loads(json.dumps(g["speicher"], default=str))
except Exception:
    store = {}
sys.stdout.buffer.write(json.dumps({"value": text, "store": store}, ensure_ascii=False).encode("utf-8"))
