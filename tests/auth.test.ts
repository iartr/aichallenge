import { describe, expect, it } from "vitest";
import {
  ADMIN_LOGIN,
  createSessionToken,
  readSessionToken,
  validateAdminCredentials,
} from "../lib/auth";

describe("admin auth", () => {
  it("accepts only admin credentials with the configured password", () => {
    expect(validateAdminCredentials(ADMIN_LOGIN, "local-password", "local-password")).toBe(true);
    expect(validateAdminCredentials("user", "local-password", "local-password")).toBe(false);
    expect(validateAdminCredentials(ADMIN_LOGIN, "wrong", "local-password")).toBe(false);
  });

  it("signs session tokens and rejects tampering", () => {
    const token = createSessionToken(
      {
        login: ADMIN_LOGIN,
        exp: Date.now() + 60_000,
      },
      "secret",
    );

    expect(readSessionToken(token, "secret")).toMatchObject({
      login: ADMIN_LOGIN,
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
