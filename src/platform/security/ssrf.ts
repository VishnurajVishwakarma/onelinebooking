import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { BookingError } from "../../domain/errors.js";

export interface SsrfValidationOptions {
  /** Allow http:// and loopback/localhost addresses strictly for local automated integration tests. */
  allowLocalHttpForTesting?: boolean | undefined;
  /** Optional custom DNS resolver override (used in SSRF & DNS-rebinding unit tests). */
  resolveAll?: ((hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>) | undefined;
}

export interface ValidatedWebhookTarget {
  url: URL;
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
}

function parseIpv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new BookingError("INVALID_INPUT", `Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0]! << 24) >>> 0) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inIpv4Cidr(ipInt: number, networkStr: string, prefixLen: number): boolean {
  const netInt = parseIpv4ToInt(networkStr);
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Checks whether an IPv4 or IPv6 literal belongs to loopback, private, link-local,
 * carrier-grade NAT, metadata, benchmark, multicast, or unspecified space.
 */
export function isRestrictedIpAddress(rawIp: string): boolean {
  const normalized = rawIp.trim().toLowerCase().split("%")[0]!;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0) return true;

  if (ipVersion === 4) {
    const n = parseIpv4ToInt(normalized);
    return (
      inIpv4Cidr(n, "0.0.0.0", 8) ||        // "This" network
      inIpv4Cidr(n, "10.0.0.0", 8) ||       // RFC 1918 private
      inIpv4Cidr(n, "100.64.0.0", 10) ||    // RFC 6598 shared/CGNAT
      inIpv4Cidr(n, "127.0.0.0", 8) ||      // Loopback
      inIpv4Cidr(n, "169.254.0.0", 16) ||   // Link-local / Cloud instance metadata (169.254.169.254)
      inIpv4Cidr(n, "172.16.0.0", 12) ||    // RFC 1918 private
      inIpv4Cidr(n, "192.0.0.0", 24) ||     // IETF protocol assignments
      inIpv4Cidr(n, "192.0.2.0", 24) ||     // TEST-NET-1
      inIpv4Cidr(n, "192.88.99.0", 24) ||   // 6to4 relay anycast
      inIpv4Cidr(n, "192.168.0.0", 16) ||   // RFC 1918 private
      inIpv4Cidr(n, "198.18.0.0", 15) ||    // Benchmarking
      inIpv4Cidr(n, "198.51.100.0", 24) ||  // TEST-NET-2
      inIpv4Cidr(n, "203.0.113.0", 24) ||   // TEST-NET-3
      inIpv4Cidr(n, "224.0.0.0", 4) ||      // Multicast
      inIpv4Cidr(n, "240.0.0.0", 4)         // Reserved / broadcast
    );
  }

  // IPv6 handling (including IPv4-mapped ::ffff:a.b.c.d or ::ffff:hex:hex)
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const tail = normalized.slice("::ffff:".length);
    if (net.isIPv4(tail)) {
      return isRestrictedIpAddress(tail);
    }
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isRestrictedIpAddress(v4);
    }
    return true;
  }

  // Expand compressed IPv6 prefix check for fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast), 100::/64
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return true;
  }

  return false;
}

/**
 * Validates a webhook endpoint URL and resolves ALL DNS records immediately prior to connection
 * so that DNS rebinding or private IP answers are rejected before opening a socket.
 */
export async function validateWebhookUrlAndResolve(
  rawUrl: string,
  options?: SsrfValidationOptions,
): Promise<ValidatedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BookingError("INVALID_INPUT", "Invalid webhook URL syntax");
  }

  const allowTestLocal = options?.allowLocalHttpForTesting === true;

  if (url.username || url.password) {
    throw new BookingError("FORBIDDEN", "Webhook URL must not embed credentials");
  }
  if (url.protocol !== "https:" && !(allowTestLocal && url.protocol === "http:")) {
    throw new BookingError(
      "FORBIDDEN",
      "Webhook URL must use HTTPS",
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) {
    throw new BookingError("INVALID_INPUT", "Webhook URL missing hostname");
  }

  const forbiddenNames = new Set([
    "metadata.google.internal",
    "metadata",
    "localhost.localdomain",
  ]);
  if (forbiddenNames.has(hostname) || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new BookingError("FORBIDDEN", `Webhook hostname '${hostname}' is blocked by egress policy`);
  }

  if (!allowTestLocal && hostname === "localhost") {
    throw new BookingError("FORBIDDEN", "Webhook target localhost is blocked by SSRF policy");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BookingError("INVALID_INPUT", "Invalid webhook port");
  }

  // Direct IP literal target
  const literalVersion = net.isIP(hostname);
  if (literalVersion === 4 || literalVersion === 6) {
    if (!allowTestLocal && isRestrictedIpAddress(hostname)) {
      throw new BookingError("FORBIDDEN", "Webhook IP target falls in a restricted network range");
    }
    return {
      url,
      pinnedAddress: hostname,
      pinnedFamily: literalVersion,
    };
  }

  const resolveFn =
    options?.resolveAll ??
    (async (h: string) => {
      const results = await dns.lookup(h, { all: true, verbatim: true });
      return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
    });

  let records: Array<{ address: string; family: 4 | 6 }>;
  try {
    records = await resolveFn(hostname);
  } catch {
    throw new BookingError("TEMPORARY_UNAVAILABLE", "DNS resolution failed for webhook target", {
      retryable: true,
    });
  }

  if (records.length === 0) {
    throw new BookingError("INVALID_INPUT", "Webhook hostname did not resolve to any IP address");
  }

  // Every resolved address MUST pass CIDR filtering (prevents dual-record round-robin SSRF bypass)
  for (const record of records) {
    if (!allowTestLocal && isRestrictedIpAddress(record.address)) {
      throw new BookingError(
        "FORBIDDEN",
        "Webhook hostname resolved to a restricted/private IP address",
      );
    }
  }

  return {
    url,
    pinnedAddress: records[0]!.address,
    pinnedFamily: records[0]!.family,
  };
}

/**
 * Executes a single SSRF-hardened HTTP POST directly against the pre-validated IP address
 * (defeating DNS rebinding) and explicitly blocks HTTP 3xx redirects.
 */
export async function sendSsrfProtectedWebhookPost(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  ssrfOptions?: SsrfValidationOptions | undefined;
}): Promise<{ status: number; bodyExcerpt: string }> {
  const target = await validateWebhookUrlAndResolve(input.url, input.ssrfOptions);

  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port
          ? Number(target.url.port)
          : target.url.protocol === "https:"
            ? 443
            : 80,
        path: `${target.url.pathname}${target.url.search}`,
        method: "POST",
        headers: {
          ...input.headers,
          Host: target.url.host,
          "Content-Length": String(Buffer.byteLength(input.body)),
        },
        timeout: input.timeoutMs,
        // Pin exact pre-validated IP at socket connect time so DNS TTL=0 cannot rebind!
        lookup: (_hostname, _opts, cb) => {
          cb(null, target.pinnedAddress, target.pinnedFamily);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(
            new BookingError(
              "FORBIDDEN",
              `Webhook HTTP redirect (${status}) blocked by SSRF egress policy`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          if (bytes < 1024) {
            chunks.push(chunk);
            bytes += chunk.length;
          }
        });
        res.on("end", () => {
          const bodyExcerpt = Buffer.concat(chunks).toString("utf8").slice(0, 500);
          resolve({ status, bodyExcerpt });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Webhook HTTP delivery timed out after ${input.timeoutMs}ms`));
    });
    req.on("error", (err) => {
      reject(err);
    });

    req.write(input.body);
    req.end();
  });
}

