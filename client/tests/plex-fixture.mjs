import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export async function startPlexFixture() {
  const directory = await mkdtemp(join(tmpdir(), "housecall-plex-fixture-"));
  await promisify(execFile)(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "20",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-hls_time",
      "2",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      join(directory, "segment%d.ts"),
      join(directory, "main.m3u8"),
    ],
    { timeout: 30000 },
  );
  const counts = {
    sections: 0,
    items: 0,
    metadata: 0,
    manifests: 0,
    segments: 0,
    unauthorized: 0,
  };
  const item = {
    ratingKey: "42",
    title: "Synthetic Plex fixture",
    type: "movie",
    duration: 20000,
    Media: [{ Part: [{ Stream: [] }] }],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:3032");
    if (req.headers["x-plex-token"] !== "fixture-secret") {
      counts.unauthorized++;
      res.writeHead(401).end();
      return;
    }
    const json = (value) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ MediaContainer: value }));
    };
    if (url.pathname === "/library/sections") {
      counts.sections++;
      json({
        Directory: [{ key: "1", title: "Fixture Movies", type: "movie" }],
      });
      return;
    }
    if (url.pathname === "/library/sections/1/all") {
      counts.items++;
      json({ Metadata: [item] });
      return;
    }
    if (url.pathname === "/library/metadata/42") {
      counts.metadata++;
      json({ Metadata: [item] });
      return;
    }
    if (url.pathname === "/video/:/transcode/universal/stop") {
      res.end();
      return;
    }
    if (url.pathname === "/video/:/transcode/universal/start.m3u8") {
      counts.manifests++;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\nsession/fixture/main.m3u8\n",
      );
      return;
    }
    const file = url.pathname.match(
      /^\/video\/:\/transcode\/universal\/session\/fixture\/(main\.m3u8|segment\d+\.ts)$/,
    )?.[1];
    if (file) {
      try {
        if (file.endsWith(".ts")) counts.segments++;
        else counts.manifests++;
        res.setHeader(
          "Content-Type",
          file.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl",
        );
        res.end(await readFile(join(directory, file)));
        return;
      } catch {}
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(3032, "127.0.0.1", resolve));
  return async () => {
    await writeFile(
      "../evidence/client-plex-fixture.json",
      JSON.stringify(
        {
          note: "Synthetic local Plex-compatible provider; no live library used.",
          counts,
        },
        null,
        2,
      ),
    );
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
}
