// Minimal clamd INSTREAM stand-in for E2E runs on machines without ClamAV.
// Answers "stream: OK" unless the stream contains the EICAR test signature. Test-only.
import { createServer } from "node:net";

const EICAR = Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");

export function startClamdFixture(path) {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let headerSeen = false;
    const body = [];
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!headerSeen) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        if (buffer.subarray(0, end).toString() !== "zINSTREAM") return socket.end("UNKNOWN COMMAND\0");
        buffer = buffer.subarray(end + 1);
        headerSeen = true;
      }
      while (buffer.length >= 4) {
        const n = buffer.readUInt32BE(0);
        if (n === 0) {
          const all = Buffer.concat(body);
          return socket.end(all.includes(EICAR) ? "stream: Eicar-Signature FOUND\0" : "stream: OK\0");
        }
        if (buffer.length < 4 + n) return;
        body.push(buffer.subarray(4, 4 + n));
        buffer = buffer.subarray(4 + n);
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(path, () => resolve(() => new Promise((done) => server.close(() => done())))));
}
