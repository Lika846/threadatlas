// Preloaded with --import: any Node-level network attempt throws and is counted.
// (The macOS sandbox profile nonet.sb blocks outbound sockets independently, including native code.)
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

let attempts = 0;
const block = (what) => () => {
  attempts++;
  throw new Error(`network blocked by tripwire: ${what}`);
};
for (const [mod, fns, name] of [
  [net, ["connect", "createConnection"], "net"],
  [tls, ["connect"], "tls"],
  [http, ["request", "get"], "http"],
  [https, ["request", "get"], "https"],
  [dns, ["lookup", "resolve", "resolve4", "resolve6"], "dns"],
]) {
  for (const f of fns) mod[f] = block(`${name}.${f}`);
}
dns.promises.lookup = block("dns.promises.lookup");
globalThis.fetch = async () => {
  attempts++;
  throw new Error("network blocked by tripwire: fetch");
};
globalThis.__tripwireAttempts = () => attempts;
process.on("exit", () => {
  process.stderr.write(`[tripwire] network attempts: ${attempts}\n`);
});
