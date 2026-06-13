import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../lib/chat-agent";
import {
  BranchingError,
  MAIN_BRANCH_ID,
  appendToActiveBranch,
  branchSummaries,
  emptyBranchingState,
  ensureBranchingState,
  forkBranch,
  getActiveBranch,
  initBranchingState,
  normalizeBranchingState,
  setActiveBranchMessages,
  setCheckpoint,
  switchBranch,
  syncCanonicalMessages,
} from "../lib/branching";

function makeMessages(count: number): AgentChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${index + 1}`,
  }));
}

describe("initBranchingState / ensureBranchingState", () => {
  it("creates a single active main branch from existing messages", () => {
    const messages = makeMessages(4);
    const state = initBranchingState(messages);

    expect(state.activeBranchId).toBe(MAIN_BRANCH_ID);
    expect(state.list).toHaveLength(1);
    expect(state.list[0].messages).toEqual(messages);
    expect(getActiveBranch(state)?.id).toBe(MAIN_BRANCH_ID);
  });

  it("ensures an empty state is hydrated but leaves a valid state untouched", () => {
    const messages = makeMessages(3);
    expect(ensureBranchingState(emptyBranchingState(), messages).list).toHaveLength(1);

    const valid = initBranchingState(messages);
    expect(ensureBranchingState(valid, [])).toBe(valid);
  });
});

describe("setCheckpoint", () => {
  it("stores a clamped checkpoint on the active branch", () => {
    const state = initBranchingState(makeMessages(4));

    expect(setCheckpoint(state, 2, "after intro").checkpoint).toEqual({
      branchId: MAIN_BRANCH_ID,
      index: 2,
      label: "after intro",
    });
    expect(setCheckpoint(state, 99, "").checkpoint?.index).toBe(4);
  });
});

describe("forkBranch", () => {
  it("clones the prefix up to the checkpoint into a new active branch", () => {
    const messages = makeMessages(6);
    let state = initBranchingState(messages);
    state = setCheckpoint(state, 4, "checkpoint");

    const { state: forked, branch } = forkBranch(state, { name: "Branch A", id: "a" });

    expect(branch.messages).toEqual(messages.slice(0, 4));
    expect(branch.parentId).toBe(MAIN_BRANCH_ID);
    expect(branch.branchedAtIndex).toBe(4);
    expect(forked.activeBranchId).toBe("a");
    // Original branch is untouched and independent.
    expect(getActiveBranch({ ...forked, activeBranchId: MAIN_BRANCH_ID })?.messages).toEqual(messages);
  });

  it("forks two independent branches from one checkpoint sharing only the prefix", () => {
    const messages = makeMessages(6);
    let state = initBranchingState(messages);
    state = setCheckpoint(state, 4, "cp");

    const a = forkBranch(state, { name: "A", id: "a" });
    let next = appendToActiveBranch(a.state, { role: "user", content: "A continues" });
    // Fork B from the SAME checkpoint while branch A is active.
    const b = forkBranch(next, { name: "B", id: "b" });
    next = b.state;

    expect(b.branch.messages).toEqual(messages.slice(0, 4));
    expect(next.activeBranchId).toBe("b");
    expect(getActiveBranch({ ...next, activeBranchId: "a" })?.messages).toHaveLength(5);
    expect(getActiveBranch({ ...next, activeBranchId: "b" })?.messages).toHaveLength(4);
  });
});

describe("switchBranch", () => {
  it("changes the active branch and throws on an unknown id", () => {
    const state = forkBranch(initBranchingState(makeMessages(2)), { id: "a" }).state;

    expect(switchBranch(state, MAIN_BRANCH_ID).activeBranchId).toBe(MAIN_BRANCH_ID);
    expect(() => switchBranch(state, "missing")).toThrow(BranchingError);
  });
});

describe("appendToActiveBranch / setActiveBranchMessages / syncCanonicalMessages", () => {
  it("appends only to the active branch", () => {
    const base = setCheckpoint(initBranchingState(makeMessages(2)), 0, "start");
    const state = forkBranch(base, { id: "a" }).state;
    const next = appendToActiveBranch(state, { role: "user", content: "new" });

    expect(syncCanonicalMessages(next)).toHaveLength(1);
    expect(getActiveBranch({ ...next, activeBranchId: MAIN_BRANCH_ID })?.messages).toHaveLength(2);
  });

  it("replaces the active branch messages and reflects them in canonical", () => {
    const state = initBranchingState(makeMessages(2));
    const replacement = makeMessages(5);
    const next = setActiveBranchMessages(state, replacement);

    expect(syncCanonicalMessages(next)).toEqual(replacement);
  });
});

describe("normalizeBranchingState", () => {
  it("returns an empty state for malformed input", () => {
    expect(normalizeBranchingState({})).toEqual(emptyBranchingState());
    expect(normalizeBranchingState(null)).toEqual(emptyBranchingState());
    expect(normalizeBranchingState({ list: "nope" })).toEqual(emptyBranchingState());
  });

  it("round-trips a valid state and repairs a dangling active id", () => {
    const state = forkBranch(setCheckpoint(initBranchingState(makeMessages(4)), 2, "cp"), { id: "a", name: "A" }).state;
    const roundTripped = normalizeBranchingState(JSON.parse(JSON.stringify(state)));

    expect(roundTripped.activeBranchId).toBe("a");
    expect(branchSummaries(roundTripped)).toEqual([
      { id: MAIN_BRANCH_ID, name: "main", messageCount: 4 },
      { id: "a", name: "A", messageCount: 2 },
    ]);

    const dangling = normalizeBranchingState({ ...JSON.parse(JSON.stringify(state)), activeBranchId: "ghost" });
    expect(dangling.activeBranchId).toBe(MAIN_BRANCH_ID);
  });
});
