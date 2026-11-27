import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "index.html"), "utf8");

export function createDocsServer() {
  return createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end('{"status":"ok"}');
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DOCS_PORT || 4300);
  const host = process.env.HOST || "0.0.0.0";
  const server = createDocsServer().listen(port, host, () => {
    console.log(`OneLineBooking Developer Docs listening on http://${host}:${port}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

