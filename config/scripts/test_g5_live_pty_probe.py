"""Regression tests for bounded G5 Unix PTY health probe (Linux only)."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest

PROBE_PATH = pathlib.Path(__file__).with_name("g5-live-pty-probe.py")
SPEC = importlib.util.spec_from_file_location("g5_pty_probe", str(PROBE_PATH))
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

@unittest.skipUnless(hasattr(socket, "SO_PEERCRED"), "Linux SO_PEERCRED required")
class HealthProbeDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="g5-probe-")
        self.addCleanup(self.dir.cleanup)
        self.sockpath = str(pathlib.Path(self.dir.name) / "daemon.sock")
        self.tokenpath = str(pathlib.Path(self.dir.name) / "daemon.token")
        pathlib.Path(self.tokenpath).write_text("fake-test-token", encoding="utf-8")
        self.original_ticks = probe.daemon_start_ticks
        self.original_deadline = probe.DEADLINE_SECONDS
        self.original_max = probe.MAX_MESSAGES
        probe.daemon_start_ticks = lambda pid: "12345"
        probe.DEADLINE_SECONDS = 0.4
        probe.MAX_MESSAGES = 12
        self.addCleanup(lambda: setattr(probe, "daemon_start_ticks", self.original_ticks))
        self.addCleanup(lambda: setattr(probe, "DEADLINE_SECONDS", self.original_deadline))
        self.addCleanup(lambda: setattr(probe, "MAX_MESSAGES", self.original_max))

    def invoke(self, handler, pid=None):
        # Probe.main throws on failures; no user token is printed.
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.sockpath)
        server.listen(1)
        self.addCleanup(server.close)
        def runner():
            try:
                conn, _ = server.accept()
                with conn:
                    conn.settimeout(1.0)
                    handler(conn)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass
        t = threading.Thread(target=runner, daemon=True)
        t.start()
        old = sys.argv
        sys.argv = ["probe", self.sockpath, self.tokenpath,
                    str(pid if pid is not None else os.getpid()), "12345"]
        start = time.monotonic()
        try:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                try:
                    probe.main()
                    error = None
                except Exception as exc:
                    error = str(exc)
        finally:
            sys.argv = old
        t.join(timeout=1.0)
        return time.monotonic() - start, error, output.getvalue()

    @staticmethod
    def read_line(conn):
        collected = b""
        while b"\n" not in collected:
            part = conn.recv(4096)
            if not part:
                raise EOFError
            collected += part
        return json.loads(collected.split(b"\n", 1)[0])

    def test_authenticated_positive(self):
        def handler(conn):
            hello = self.read_line(conn)
            assert hello["version"] == 54 and hello["token"] == "fake-test-token"
            conn.sendall(b'{"type":"hello","ok":true}\n')
            request = self.read_line(conn)
            assert request["type"] == "ptySpawnHealth"
            conn.sendall(b'{"id":"g5-health-1","ok":true,"payload":{"coverage":"pty-spawn"}}\n')
        elapsed, error, output = self.invoke(handler)
        self.assertIsNone(error)
        self.assertLess(elapsed, 1.0)
        self.assertTrue(json.loads(output)["healthy"])

    def test_unrelated_message_flood_is_bounded(self):
        def handler(conn):
            self.read_line(conn)
            conn.sendall(b'{"type":"hello","ok":true}\n')
            self.read_line(conn)
            for i in range(200):
                conn.sendall((json.dumps({"id": f"unrelated-{i}"}) + "\n").encode())
        elapsed, error, _ = self.invoke(handler)
        self.assertLess(elapsed, 1.0)
        self.assertIn("excessive unrelated", error)

    def test_trickle_does_not_reset_total_deadline(self):
        def handler(conn):
            self.read_line(conn)
            conn.sendall(b'{"type":"hello","ok":true}\n')
            self.read_line(conn)
            for _ in range(80):
                conn.sendall(b" ")
                time.sleep(0.05)
        elapsed, error, _ = self.invoke(handler)
        self.assertLess(elapsed, 1.0)
        self.assertIn("deadline", error)

    def test_wrong_socket_peer_is_rejected(self):
        elapsed, error, _ = self.invoke(lambda conn: time.sleep(0.1), os.getpid() + 20)
        self.assertLess(elapsed, 1.0)
        self.assertIn("peer PID mismatch", error)

if __name__ == "__main__":
    unittest.main()
