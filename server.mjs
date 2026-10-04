// Production entrypoint (`npm start`). Wraps Next.js only to stamp the TCP peer address into
// X-FD-Socket-IP, overwriting anything the client sent, because App Router handlers cannot see the socket.
// Behind a proxy (Railway) set TRUST_PROXY=true so X-Forwarded-For is used instead.
import { createServer } from "node:http";
import next from "next";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();
createServer((req, res) => {
  req.headers["x-fd-socket-ip"] = req.socket.remoteAddress ?? "";
  handle(req, res);
}).listen(port, hostname, () => console.log(`> Fair Drop ready on http://${hostname}:${port}`));
