"""Full Doodle Dash game: host (laptop) + Alice (phone) + Bob (phone) + Cara (laptop).
Needs: python -m http.server 8770 --bind 127.0.0.1 (in DoodleDash) and python -u _dev/peer_server.py 9000.
Set LIVE=1 to use the real public PeerJS server instead of the local stand-in."""
import os, time, math, pathlib
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8770/"
SHOTS = pathlib.Path(__file__).parent / "_shots"; SHOTS.mkdir(exist_ok=True)
LIVE = os.environ.get("LIVE") == "1"
INIT = ("" if LIVE else "window.DD_TEST_PEER = { host: '127.0.0.1', port: 9000, path: '/', secure: false };") + "window.DD_TEST_FAST = true;"
# Block direct WebRTC like a company network does: the game must not need it.
INIT += """(() => { const R = window.RTCPeerConnection; if (!R) return;
  window.RTCPeerConnection = function (c) { return new R(Object.assign({}, c || {}, { iceServers: [], iceTransportPolicy: 'relay' })); };
  window.RTCPeerConnection.prototype = R.prototype; })();"""
errors = []
def log(*a): print(*a, flush=True)
def shot(pg, name): pg.screenshot(path=str(SHOTS / f"{name}.png"))

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    def page(name, phone):
        opts = dict(viewport={"width": 390, "height": 760}, is_mobile=True, has_touch=True, device_scale_factor=2) if phone else dict(viewport={"width": 1366, "height": 768})
        ctx = b.new_context(**opts); ctx.add_init_script(INIT)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"{name} pageerror: {e}"))
        pg.on("console", lambda m: errors.append(f"{name} console: {m.text[:200]}") if m.type == "error" else None)
        pg.on("dialog", lambda d: d.accept())
        return pg

    host = page("Host", False)
    host.goto(BASE)
    time.sleep(1.2); shot(host, "01_home_laptop")
    host.click("#btn-create")
    host.fill("#in-name", "Vinny")
    host.click("#av-tabs button[data-tab='1']"); host.click("#av-grid button:nth-child(3)")
    host.click("#btn-prof")
    host.wait_for_function("/^\\d{6}$/.test(document.getElementById('lb-pin').textContent)", timeout=30000)
    pin = host.inner_text("#lb-pin"); log("PIN", pin)

    players = []
    for i, (name, phone) in enumerate([("Alice", True), ("Bob", True), ("Cara", False)]):
        pg = page(name, phone)
        pg.goto(BASE + "?pin=" + pin)
        pg.wait_for_selector("#scr-profile:not([hidden])")
        pg.fill("#in-name", name)
        pg.click(f"#av-tabs button[data-tab='{(i + 2) % 6}']"); pg.click(f"#av-grid button:nth-child({i + 2})")
        pg.click(f"#col-grid button:nth-child({i + 3})")
        if name == "Alice": time.sleep(0.6); shot(pg, "02_phone_profile")
        pg.click("#btn-prof")
        players.append((name, pg))
    for name, pg in players:
        pg.wait_for_selector("#scr-lobby:not([hidden])", timeout=30000)
    host.wait_for_function("document.getElementById('lb-count').textContent === '4'", timeout=15000)
    host.click("[data-time='60']"); host.click("[data-toggle='locked']")
    time.sleep(1.2); shot(host, "03_lobby_host"); shot(players[0][1], "04_lobby_phone")

    # A stranger with the PIN cannot get in once the room is locked
    stranger = page("Stranger", True)
    stranger.goto(BASE + "?pin=" + pin); stranger.fill("#in-name", "Stranger"); stranger.click("#btn-prof")
    stranger.wait_for_selector("text=This game is locked", timeout=20000)
    log("locked room refused the stranger:", stranger.inner_text("#msg-body").split("\n")[1])
    host.click("[data-toggle='locked']")

    everyone = [("Vinny", host)] + players
    by_pid = {}
    for name, pg in everyone:
        pg.wait_for_function("window.__dd.state && window.__dd.state.players.length === 4")
    for name, pg in everyone:
        me = pg.evaluate("window.__dd.state.players.filter(p => p.name === %r)[0].pid" % name)
        by_pid[me] = (name, pg)

    host.click("#lb-start", force=True)
    turn = 0
    refreshed = False
    while True:
        host.wait_for_function("['choose','end'].includes(window.__dd.state.phase)", timeout=30000)
        if host.evaluate("window.__dd.state.phase") == "end": break
        turn += 1
        drawer_pid = host.evaluate("window.__dd.state.drawer")
        dname, dpg = by_pid[drawer_pid]
        dpg.wait_for_selector("#overlay [data-pick]", timeout=15000)
        if turn == 1: time.sleep(0.5); shot(dpg, f"05_choose_{dname}"); shot(host if dpg is not host else players[0][1], "06_waiting_choose")
        dpg.click("#overlay [data-pick='0']")
        dpg.wait_for_function("window.__dd.state.phase === 'draw' && window.__dd.word", timeout=10000)
        word = dpg.evaluate("window.__dd.word")
        log(f"turn {turn}: {dname} draws '{word}'")
        # draw: a circle and a zigzag on the canvas
        box = dpg.locator("#board").bounding_box()
        cx, cy, r = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, box["height"] * 0.3
        dpg.mouse.move(cx + r, cy); dpg.mouse.down()
        for k in range(1, 41):
            a = k / 40 * 2 * math.pi
            dpg.mouse.move(cx + r * math.cos(a), cy + r * math.sin(a), steps=2)
        dpg.mouse.up()
        dpg.mouse.move(box["x"] + 20, box["y"] + 20); dpg.mouse.down()
        for k in range(12):
            dpg.mouse.move(box["x"] + 20 + k * box["width"] / 14, box["y"] + 20 + (30 if k % 2 else 0), steps=3)
        dpg.mouse.up()
        if turn == 1:
            dpg.click("#palette [data-color='#ffd23f']"); dpg.click("#modes [data-mode='fill']")
            dpg.mouse.click(cx, cy)
        time.sleep(1.5)
        guessers = [(n, pg) for n, pg in everyone if pg is not dpg]
        n_ops = dpg.evaluate("window.__dd.board.opsCount()")
        seen = [pg.evaluate("window.__dd.board.opsCount()") for _, pg in guessers]
        log(f"   drawer has {n_ops} drawing operations; guessers see {seen}")
        if turn == 1:
            shot(dpg, f"07_drawing_{dname}")
            shot(guessers[0][1], f"08_guesser_{guessers[0][0]}")
            shot(guessers[1][1], f"09_guesser_{guessers[1][0]}")
        if not refreshed and turn == 2:
            rn, rpg = [g for g in guessers if g[0] != "Vinny"][0]
            rpg.reload(); rpg.wait_for_selector("#scr-profile:not([hidden])"); rpg.click("#btn-prof")
            rpg.wait_for_selector("#scr-game:not([hidden])", timeout=30000); time.sleep(2.5)
            log(f"   {rn} refreshed mid-turn: sees {rpg.evaluate('window.__dd.board.opsCount()')} operations, score kept:",
                rpg.evaluate("window.__dd.state.players.filter(p=>p.name===%r)[0].score" % rn))
            refreshed = True
        # guesses: a wrong one, a close one (when possible), then correct ones
        g0 = guessers[0][1]
        g0.fill("#chat-in", "potato wizard"); g0.press("#chat-in", "Enter"); time.sleep(0.5)
        if len(word.replace(" ", "")) >= 5:
            close = word[:-1] + ("x" if word[-1] != "x" else "y")
            g0.fill("#chat-in", close); g0.press("#chat-in", "Enter"); time.sleep(0.6)
        dpg.fill("#chat-in", word); dpg.press("#chat-in", "Enter"); time.sleep(0.4)  # artist tries to give it away
        for k, (gn, gpg) in enumerate(guessers):
            gpg.fill("#chat-in", word.upper() if k == 1 else word); gpg.press("#chat-in", "Enter"); time.sleep(0.9)
            if turn == 1 and k == 0: time.sleep(0.6); shot(gpg, f"10_guessed_{gn}")
        host.wait_for_function("window.__dd.state.phase === 'reveal'", timeout=15000)
        time.sleep(0.7)
        if turn == 1:
            shot(guessers[1][1], "11_reveal")
            log("   chat seen by", guessers[0][0], ":", " | ".join(guessers[0][1].inner_text("#chat-log").split("\n")[-8:]))
        log("   scores:", host.evaluate("window.__dd.state.players.map(p => p.name + ' ' + p.score).join(', ')"))
    log("game over after", turn, "turns")
    for name, pg in everyone:
        pg.wait_for_selector("#scr-end:not([hidden])", timeout=15000)
    time.sleep(2.2); shot(host, "12_end_laptop"); shot(players[0][1], "13_end_phone")
    log("final:", host.inner_text("#podium").replace("\n", " | "))
    host.click("#end-again")
    for name, pg in players:
        pg.wait_for_selector("#scr-lobby:not([hidden])", timeout=15000)
    log("play again: everyone back in the lobby, scores", host.evaluate("window.__dd.state.players.map(p=>p.score).join(',')"))
    b.close()

log("ERRORS:", len(errors))
for e in errors: log("  ", e)
