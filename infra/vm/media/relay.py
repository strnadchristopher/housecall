"""A single local rfbsrc connection to one private QEMU Unix VNC socket."""
import select
import socket
import threading


class DisplayRelay:
    def __init__(self, path):
        self.path = path
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            self.listener.settimeout(0.2)
            while not self.stopped.is_set():
                try:
                    local, _ = self.listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                return
            self.listener.close()  # Never accept a second RFB client.
            with local, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as remote:
                remote.settimeout(0.5)
                remote.connect(self.path)
                local.settimeout(0.5)
                peers = {local: remote, remote: local}
                while not self.stopped.is_set():
                    ready, _, _ = select.select(list(peers), [], [], 0.2)
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        peers[source].sendall(data)
        except OSError:
            pass  # Closing capture or a pipeline error terminates the worker.

    def close(self):
        self.stopped.set()
        self.listener.close()
        self.thread.join(timeout=1)
