#!/usr/bin/env python3
"""Bounded authenticated live PTY daemon health: protocol 54 with process identity."""
import json
import socket
import struct
import sys
import time

DEADLINE_SECONDS = 5.0
MAX_MESSAGES = 128
MAX_BUFFER = 250_000

def daemon_start_ticks(pid):
    # Linux proc fields start at index 3 after the process name in parentheses.
    with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
        value = handle.read()
    end_name = value.rfind(")")
    if end_name < 0:
        raise RuntimeError("malformed daemon process record")
    fields = value[end_name + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise RuntimeError("invalid daemon start time")
    return fields[19]

def main():
    if len(sys.argv) != 5:
        raise RuntimeError("expected socket path, token file, daemon PID and start ticks")
    socket_path, token_path, pid_text, expected_ticks = sys.argv[1:]
    pid = int(pid_text)
    if pid <= 1:
        raise RuntimeError("invalid expected daemon PID")
    before = daemon_start_ticks(pid)
    if before != expected_ticks:
        raise RuntimeError("daemon incarnation changed before protocol handshake")
    with open(token_path, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        raise RuntimeError("missing daemon token")
    start = time.monotonic()
    deadline = start + DEADLINE_SECONDS
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError("live daemon health exceeded total deadline")
            return value
        client.settimeout(remaining())
        client.connect(socket_path)
        if not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("Unix peer identity unavailable")
        creds = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        peer_pid, _, _ = struct.unpack("3i", creds)
        if peer_pid != pid:
            raise RuntimeError("daemon socket peer PID mismatch")
        pending = b""
        count = 0
        def send(obj):
            remaining()
            client.settimeout(remaining())
            client.sendall((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        def recv():
            nonlocal pending, count
            while b"\n" not in pending:
                client.settimeout(remaining())
                try:
                    chunk = client.recv(65536)
                except TimeoutError as exc:
                    raise TimeoutError("live daemon health exceeded total deadline") from exc
                if not chunk:
                    raise RuntimeError("daemon closed health socket")
                pending += chunk
                if len(pending) > MAX_BUFFER:
                    raise RuntimeError("daemon health frame oversized")
            remaining()
            count += 1
            if count > MAX_MESSAGES:
                raise RuntimeError("daemon sent excessive unrelated health messages")
            line, pending = pending.split(b"\n", 1)
            if len(line) > MAX_BUFFER:
                raise RuntimeError("daemon health line oversized")
            return json.loads(line)
        send({"type": "hello", "version": 54, "token": token,
              "clientId": "g5-live-health", "role": "control"})
        hello = recv()
        if hello.get("type") != "hello" or hello.get("ok") is not True:
            raise RuntimeError("daemon refused authenticated protocol-54 hello")
        send({"id": "g5-health-1", "type": "ptySpawnHealth"})
        while True:
            result = recv()
            if result.get("id") != "g5-health-1":
                continue
            payload = result.get("payload") or {}
            if result.get("ok") is not True or payload.get("coverage") != "pty-spawn":
                raise RuntimeError("daemon did not pass live PTY spawn preflight")
            after = daemon_start_ticks(pid)
            if after != before:
                raise RuntimeError("daemon restarted during health probe")
            remaining()
            print(json.dumps({"healthy": True, "protocolVersion": 54,
                              "coverage": "pty-spawn", "daemonPid": pid,
                              "startTicks": before,
                              "roundTripMs": round((time.monotonic() - start) * 1000, 1)}))
            return

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"healthy": False, "error": str(exc)[:160]}))
        sys.exit(1)
