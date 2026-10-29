import esprima, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent / "js"
for f in ["config.js", "link.js", "common.js", "words.js", "board.js", "host.js", "app.js"]:
    src = (root / f).read_text(encoding="utf-8")
    n = src.count("?.") + len(re.findall(r"\?\?", src))
    norm = re.sub(r"\?\?", "||", src.replace("?.", "."))
    try:
        esprima.parseScript(norm, options={"tolerant": False})
        print(f, "OK", f"(rewrote {n} ?./?? sites)")
    except Exception as e:
        print(f, "FAIL", e)
