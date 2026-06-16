import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN,
  createSessionToken,
  hashPassword,
  readSessionToken,
  verifyPassword,
} from "../lib/auth";

describe("auth", () => {
  it("hashes passwords and verifies only the matching password", async () => {
    const passwordHash = await hashPassword("local-password", "fixed-test-salt");

    expect(passwordHash.hash).not.toBe("local-password");
    expect(await verifyPassword("local-password", passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", passwordHash)).toBe(false);
    expect(await verifyPassword("local-password", { ...passwordHash, algorithm: "unknown" })).toBe(false);
  });

  it("signs session tokens for seeded logins and rejects tampering", () => {
    const token = createSessionToken(
      {
        login: "admin2",
        exp: Date.now() + 60_000,
      },
      "secret",
    );

    expect(readSessionToken(token, "secret")).toMatchObject({
      login: "admin2",
    });
    expect(readSessionToken(`${token}tampered`, "secret")).toBeNull();
    expect(readSessionToken(token, "other-secret")).toBeNull();
  });

  it("rejects expired session tokens", () => {
    const token = createSessionToken(
      {
        login: ADMIN_LOGIN,
        exp: Date.now() - 1,
      },
      "secret",
    );

    expect(readSessionToken(token, "secret")).toBeNull();
  });
});
