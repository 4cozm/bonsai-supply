/**
 * 의존성 없는 로컬 정적 서버. GitHub Pages와 같은 조건(상대 경로, 정적 파일)에서
 * 프론트를 확인하기 위한 용도이며 배포에는 쓰지 않는다.
 *
 *   node web/dev-server.mjs
 */
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    // ROOT 밖으로 나가는 경로는 거부한다.
    const target = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(ROOT)) {
        res.writeHead(403).end("Forbidden");
        return;
    }

    let file = target;
    try {
        const info = await stat(file);
        if (info.isDirectory()) file = join(file, "index.html");
        await stat(file);
    } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
    }

    res.writeHead(200, {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
    console.log(`web: http://localhost:${PORT}`);
});
