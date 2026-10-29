"""Local stand-in for the public PeerJS server (0.peerjs.com), for tests only.

Mirrors peerjs-server's behaviour (github.com/peers/peerjs-server, src/messageHandler):
- GET /peerjs/id hands out a random id; WebSocket /peerjs?key=&id=&token= registers a client and sends OPEN.
- OFFER / ANSWER / CANDIDATE / LEAVE / EXPIRE are forwarded to `dst` with `src` stamped by the server.
- Messages for an offline dst are queued; after 5 s the sender gets EXPIRE (the client turns that into "peer-unavailable").
- A taken id gets ID-TAKEN.
Run: python peer_server.py [port]
"""
import asyncio, json, secrets, sys, time
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
# Optional 2nd argument: refuse the first N player connections with HTTP 429, like a busy public server.
FLAKY = [int(sys.argv[2]) if len(sys.argv) > 2 else 0]
clients = {}          # id -> websocket
queue = {}            # dst -> [(time, message)]
FORWARD = {"OFFER", "ANSWER", "CANDIDATE", "LEAVE", "EXPIRE"}


def http(connection, request):
    path = request.path.split("?")[0]
    if path.endswith("/id"):
        body = secrets.token_hex(8).encode()
        return Response(200, "OK", Headers({"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*",
                                            "Content-Length": str(len(body))}), body)
    if FLAKY[0] > 0 and "-p-" in request.path:
        FLAKY[0] -= 1
        print("refused a player connection with 429 (left:", FLAKY[0], ")", flush=True)
        return Response(429, "Too Many Requests", Headers({"Content-Length": "0"}), b"")
    return None  # carry on with the WebSocket handshake


async def send(ws, msg):
    try:
        await ws.send(json.dumps(msg))
    except Exception:
        pass


async def handler(ws):
    q = dict(p.split("=", 1) for p in ws.request.path.split("?", 1)[-1].split("&") if "=" in p)
    cid = q.get("id", "")
    if not cid or cid in clients:
        await send(ws, {"type": "ID-TAKEN", "payload": {"msg": "ID is taken"}})
        await ws.close()
        return
    clients[cid] = ws
    await send(ws, {"type": "OPEN"})
    for _, m in queue.pop(cid, []):
        await send(ws, m)
    try:
        async for raw in ws:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            t = m.get("type")
            if t not in FORWARD:
                continue
            # Like 0.peerjs.com (verified Oct 2026): a CANDIDATE must look real and stay small,
            # otherwise the sender is disconnected and nothing is forwarded.
            if t == "CANDIDATE":
                pl = m.get("payload") or {}
                if not isinstance(pl.get("candidate"), dict) or not pl.get("connectionId") or not pl.get("type") or len(raw) > 16000:
                    print("dropped a malformed CANDIDATE and disconnected", cid, flush=True)
                    await ws.close()
                    break
            out = {"type": t, "src": cid, "dst": m.get("dst"), "payload": m.get("payload")}
            dst = clients.get(out["dst"])
            if dst:
                await send(dst, out)
            elif t not in ("LEAVE", "EXPIRE") and out["dst"]:
                queue.setdefault(out["dst"], []).append((time.time(), out))
    finally:
        if clients.get(cid) is ws:
            del clients[cid]


async def expire_loop():
    while True:
        await asyncio.sleep(1)
        now = time.time()
        for dst in list(queue):
            keep = []
            for t, m in queue[dst]:
                if now - t > 5:
                    src = clients.get(m["src"])
                    if src:
                        await send(src, {"type": "EXPIRE", "src": dst, "dst": m["src"]})
                else:
                    keep.append((t, m))
            if keep:
                queue[dst] = keep
            else:
                del queue[dst]


async def main():
    async with serve(handler, "127.0.0.1", PORT, process_request=http):
        print(f"peer server on {PORT}", flush=True)
        await expire_loop()

asyncio.run(main())
