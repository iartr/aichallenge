import { describe, expect, it } from "vitest";
import { normalizeSpeechModels } from "../lib/assemblyai";

describe("AssemblyAI speech models", () => {
  it("maps legacy best model to the current universal model field", () => {
    expect(normalizeSpeechModels("best")).toEqual(["universal-2"]);
  });

  it("supports comma-separated speech model lists", () => {
    expect(normalizeSpeechModels("universal-3-pro, universal-2")).toEqual(["universal-3-pro", "universal-2"]);
  });
});
