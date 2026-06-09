import { describe, expect, it } from "vitest";
import { buildConversationTitle, normalizeStoredMessages } from "../lib/conversations";

describe("conversation persistence helpers", () => {
  it("builds compact titles from the first user message", () => {
    expect(buildConversationTitle("  Remember   my city is Lisbon  ")).toBe("Remember my city is Lisbon");
    expect(buildConversationTitle("a".repeat(60))).toBe(`${"a".repeat(49)}...`);
    expect(buildConversationTitle("   ")).toBe("New chat");
  });

  it("keeps only valid stored chat messages", () => {
    expect(
      normalizeStoredMessages([
        {
          role: "user",
          content: " Hello ",
        },
        {
          role: "system",
          content: "Drop me",
        },
        {
          role: "assistant",
          content: " Hi ",
        },
        {
          role: "user",
          content: "",
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "assistant",
        content: "Hi",
      },
    ]);
  });
});
