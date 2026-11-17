#!/usr/bin/env python3
"""Check a live Orca PTY daemon by authenticated protocol-54 request/response.

Never prints the token or socket path, only a bounded JSON health result.
Run *inside* the isolated Docker container; read paths from the daemon PID.
"""
import json
import socket
import sys
import time

def main():
    if len(sys.argv) != 3:
        raise RuntimeError("expected daemon socket path and token file")
    socket_path, token_path = sys.argv[1:]
    with open(token_path, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        raise RuntimeError("missing daemon token")
    start = time.monotonic()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(4.0)
        client.connect(socket_path)
        buffer = b""
        def send(obj):
            client.sendall((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        def recv():
            nonlocal buffer
            while b"\n" not in buffer:
                part = client.recv(65536)
                if not part: raise RuntimeError("daemon closed health socket")
                buffer += part
                if len(buffer) > 250000: raise RuntimeError("oversize daemon health response")
            line, buffer = buffer.split(b"\n", 1)
            return json.loads(line)
        send({"type":"hello","version":54,"token":token,"clientId":"g5-live-health","role":"control"})
        hello = recv()
        if hello.get("type") != "hello" or hello.get("ok") is not True:
            raise RuntimeError("daemon refused authenticated protocol-54 hello")
        send({"id":"g5-health-1","type":"ptySpawnHealth"})
        while True:
            answer = recv()
            if answer.get("id") != "g5-health-1": continue
            payload = answer.get("payload") or {}
            if answer.get("ok") is not True or payload.get("coverage") != "pty-spawn":
                raise RuntimeError("daemon did not pass live PTY spawn preflight")
            print(json.dumps({"healthy":True,"protocolVersion":54,
                              "coverage":"pty-spawn",
                              "roundTripMs":round((time.monotonic()-start)*1000,1)}))
            return
if __name__ == "__main__":
    try: main()
    except Exception as exc:
        print(json.dumps({"healthy":False, "error":str(exc)[:160]}))
        sys.exit(1)
