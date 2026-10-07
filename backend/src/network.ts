import { networkInterfaces } from "node:os";
import type { NextFunction, Request, Response } from "express";

// Who may use the app: this PC and other PCs on the same local network.
// Remote access (for example over Tailscale, which uses 100.x.x.x addresses) comes later
// with a login (ticket FRG-17), so those requests are refused for now.

// Turn "::ffff:10.0.0.5" (how Node shows IPv4 on an IPv6 socket) into "10.0.0.5".
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLocalNetworkAddress(rawAddress: string | undefined): boolean {
  if (!rawAddress) return false;
  const address = plainAddress(rawAddress).toLowerCase();

  // This PC.
  if (address === "::1" || address.startsWith("127.")) return true;
  // IPv6 link-local: only reachable on the same network.
  if (address.startsWith("fe80:")) return true;

  // Private IPv4 ranges used by home and office networks.
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0 - 10.255.255.255
  if (a === 192 && b === 168) return true; // 192.168.0.0 - 192.168.255.255
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0 - 172.31.255.255
  return false;
}

// Express middleware: refuse every request that does not come from this PC or the local network.
export function localNetworkOnly(req: Request, res: Response, next: NextFunction) {
  if (isLocalNetworkAddress(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(403).type("text/plain").send("TeczoForge can only be used from the local network for now.");
}

// The addresses other PCs on the local network can use to reach this PC, for the start-up log.
export function localNetworkAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family === "IPv4" && !info.internal && isLocalNetworkAddress(info.address)) found.push(info.address);
    }
  }
  return found;
}
