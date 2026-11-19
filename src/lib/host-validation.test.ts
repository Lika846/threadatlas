import { describe, expect, it } from "vitest";
import { checkRequestHost, isAllowedHost } from "./host-validation";

describe("isAllowedHost", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.1:3000",
    "127.0.0.1:3100",
    "localhost",
    "localhost:3000",
    "LOCALHOST:3000",
  ])("allows loopback host %s", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    // DNS-rebinding style: attacker-controlled names resolving to 127.0.0.1
    "evil.example",
    "evil.example:3000",
    "localhost.evil.example:3000",
    "127.0.0.1.nip.io:3000",
    "localhostx:3000",
    // Other interfaces / addresses
    "0.0.0.0:3000",
    "192.168.1.10:3000",
    "127.0.0.2:3000",
    "[::1]:3000",
    // Malformed or ambiguous values
    "",
    " ",
    "localhost:",
    "localhost:0",
    "localhost:65536",
    "localhost:3000:3000",
    "localhost.",
    "localhost.:3000",
    "user@localhost:3000",
    "localhost/path",
    "localhost, evil.example",
    " localhost:3000",
    "localhost:3000 ",
  ])("rejects %j", (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});

describe("checkRequestHost", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("accepts a loopback Host without X-Forwarded-Host", () => {
    expect(checkRequestHost(headers({ host: "127.0.0.1:3000" }))).toEqual({
      ok: true,
    });
  });

  it("rejects a missing Host", () => {
    expect(checkRequestHost(headers({}))).toEqual({
      ok: false,
      reason: "missing-host",
    });
  });

  it("rejects a foreign Host", () => {
    expect(checkRequestHost(headers({ host: "evil.example:3000" }))).toEqual({
      ok: false,
      reason: "host-not-allowed",
    });
  });

  it("rejects a foreign X-Forwarded-Host even when Host is loopback", () => {
    expect(
      checkRequestHost(
        headers({ host: "localhost:3000", "x-forwarded-host": "evil.example" }),
      ),
    ).toEqual({ ok: false, reason: "forwarded-host-not-allowed" });
  });

  it("rejects a forwarded list containing any foreign host", () => {
    expect(
      checkRequestHost(
        headers({
          host: "localhost:3000",
          "x-forwarded-host": "localhost:3000, evil.example",
        }),
      ),
    ).toEqual({ ok: false, reason: "forwarded-host-not-allowed" });
  });

  it("accepts a loopback X-Forwarded-Host", () => {
    expect(
      checkRequestHost(
        headers({ host: "localhost:3000", "x-forwarded-host": "127.0.0.1:3000" }),
      ),
    ).toEqual({ ok: true });
  });
});
