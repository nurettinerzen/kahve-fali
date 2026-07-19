// Prototipleri http:// üzerinden servis eder (file:// yerine).
//   node statik.mjs        → http://localhost:8790/kahve-fali.html
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";

const PORT = process.env.PORT || 8790;
const ROOT = new URL(".", import.meta.url).pathname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/kahve-fali.html";

  // dizin dışına çıkışı engelle
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, safe);
  if (!file.startsWith(ROOT) || safe.startsWith("/.env") || safe.includes("node_modules")) {
    res.writeHead(403).end("yasak");
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end('<p style="font-family:sans-serif">Bulunamadı. Dene: <a href="/kahve-fali.html">kahve-fali.html</a> · <a href="/su-siralama.html">su-siralama.html</a></p>');
  }
}).listen(PORT, () => console.log(`Prototipler → http://localhost:${PORT}/kahve-fali.html`));
