import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve as pathResolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = pathResolve(__dirname, "site");
console.log("SITE_ROOT:", SITE_ROOT);
console.log("exists:", existsSync(SITE_ROOT));
console.log("index.html exists:", existsSync(pathResolve(SITE_ROOT, "index.html")));

const server = createServer((req, res) => {
  console.log("request:", req.url);
  let reqPath = req.url.split("?")[0];
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = pathResolve(SITE_ROOT, reqPath.slice(1));
  console.log("filePath:", filePath);
  console.log("exists:", existsSync(filePath));
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(4176, "0.0.0.0", () => {
  console.log("listening on 4176");
});
