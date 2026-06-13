import { randomUUID } from "node:crypto";
import { normalizeStoredMessages } from "./conversations";
import type { AgentChatMessage } from "./chat-agent";

export const MAIN_BRANCH_ID = "main";
export const MAIN_BRANCH_NAME = "main";

export type Branch = {
  id: string;
  name: string;
  messages: AgentChatMessage[];
  parentId: string | null;
  branchedAtIndex: number;
};

export type Checkpoint = {
  branchId: string;
  index: number;
  label: string;
} | null;

export type BranchingState = {
  activeBranchId: string | null;
  checkpoint: Checkpoint;
  list: Branch[];
};

export class BranchingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BranchingError";
    this.status = status;
  }
}

export function emptyBranchingState(): BranchingState {
  return {
    activeBranchId: null,
    checkpoint: null,
    list: [],
  };
}

/** Lazily materialize a "main" branch holding the conversation's current messages. */
export function initBranchingState(messages: AgentChatMessage[]): BranchingState {
  return {
    activeBranchId: MAIN_BRANCH_ID,
    checkpoint: null,
    list: [
      {
        id: MAIN_BRANCH_ID,
        name: MAIN_BRANCH_NAME,
        messages: cloneMessages(messages),
        parentId: null,
        branchedAtIndex: 0,
      },
    ],
  };
}

/** Ensure there is an active branch; create one from `messages` if the state is empty. */
export function ensureBranchingState(state: BranchingState, messages: AgentChatMessage[]): BranchingState {
  if (state.list.length && state.activeBranchId && findBranch(state, state.activeBranchId)) {
    return state;
  }

  return initBranchingState(messages);
}

export function getActiveBranch(state: BranchingState): Branch | null {
  if (!state.activeBranchId) {
    return null;
  }

  return findBranch(state, state.activeBranchId);
}

export function syncCanonicalMessages(state: BranchingState): AgentChatMessage[] {
  return getActiveBranch(state)?.messages ?? [];
}

export function setCheckpoint(state: BranchingState, index: number, label: string): BranchingState {
  const branch = getActiveBranch(state);

  if (!branch) {
    throw new BranchingError("No active branch to checkpoint.");
  }

  const safeIndex = clampIndex(index, branch.messages.length);

  return {
    ...state,
    checkpoint: {
      branchId: branch.id,
      index: safeIndex,
      label: label.trim() || `after ${safeIndex} msgs`,
    },
  };
}

/**
 * Fork a new branch from a checkpoint (or the chosen / current point). Clones the
 * active branch's messages[0..forkIndex] so the fork is independent. Forking twice
 * from the same checkpoint yields two branches that share only the common prefix.
 */
export function forkBranch(
  state: BranchingState,
  options: { name?: string; atIndex?: number; id?: string; fromBranchId?: string } = {},
): { state: BranchingState; branch: Branch } {
  const checkpoint = state.checkpoint;
  // Fork from the checkpoint's branch so two forks from one checkpoint share a
  // prefix, regardless of which branch is currently active.
  const sourceId = options.fromBranchId ?? checkpoint?.branchId ?? state.activeBranchId ?? undefined;
  const source = (sourceId ? findBranch(state, sourceId) : null) ?? getActiveBranch(state);

  if (!source) {
    throw new BranchingError("No active branch to fork from.");
  }

  const checkpointIndex =
    checkpoint && checkpoint.branchId === source.id ? checkpoint.index : source.messages.length;
  const forkIndex = clampIndex(options.atIndex ?? checkpointIndex, source.messages.length);
  const branch: Branch = {
    id: options.id ?? randomUUID(),
    name: options.name?.trim() || nextBranchName(state),
    messages: cloneMessages(source.messages.slice(0, forkIndex)),
    parentId: source.id,
    branchedAtIndex: forkIndex,
  };

  return {
    state: {
      ...state,
      activeBranchId: branch.id,
      list: [...state.list, branch],
    },
    branch,
  };
}

export function switchBranch(state: BranchingState, branchId: string): BranchingState {
  if (!findBranch(state, branchId)) {
    throw new BranchingError("Branch not found.", 404);
  }

  return {
    ...state,
    activeBranchId: branchId,
  };
}

export function appendToActiveBranch(state: BranchingState, ...messages: AgentChatMessage[]): BranchingState {
  const branch = getActiveBranch(state);

  if (!branch) {
    throw new BranchingError("No active branch to append to.");
  }

  return {
    ...state,
    list: state.list.map((entry) =>
      entry.id === branch.id ? { ...entry, messages: [...entry.messages, ...messages] } : entry,
    ),
  };
}

export function setActiveBranchMessages(state: BranchingState, messages: AgentChatMessage[]): BranchingState {
  const branch = getActiveBranch(state);

  if (!branch) {
    throw new BranchingError("No active branch to update.");
  }

  return {
    ...state,
    list: state.list.map((entry) =>
      entry.id === branch.id ? { ...entry, messages: cloneMessages(messages) } : entry,
    ),
  };
}

export function normalizeBranchingState(value: unknown): BranchingState {
  if (!isRecord(value) || !Array.isArray(value.list)) {
    return emptyBranchingState();
  }

  const list: Branch[] = [];

  for (const entry of value.list) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) {
      continue;
    }

    list.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
      messages: normalizeStoredMessages(entry.messages),
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      branchedAtIndex: readNonNegativeInt(entry.branchedAtIndex),
    });
  }

  if (!list.length) {
    return emptyBranchingState();
  }

  const activeBranchId =
    typeof value.activeBranchId === "string" && list.some((branch) => branch.id === value.activeBranchId)
      ? value.activeBranchId
      : list[0].id;

  return {
    activeBranchId,
    checkpoint: normalizeCheckpoint(value.checkpoint, list),
    list,
  };
}

/** Compact branch list for API/UI consumers (no message bodies). */
export function branchSummaries(state: BranchingState) {
  return state.list.map((branch) => ({
    id: branch.id,
    name: branch.name,
    messageCount: branch.messages.length,
  }));
}

function normalizeCheckpoint(value: unknown, list: Branch[]): Checkpoint {
  if (!isRecord(value) || typeof value.branchId !== "string") {
    return null;
  }

  if (!list.some((branch) => branch.id === value.branchId)) {
    return null;
  }

  return {
    branchId: value.branchId,
    index: readNonNegativeInt(value.index),
    label: typeof value.label === "string" ? value.label : "",
  };
}

function nextBranchName(state: BranchingState) {
  return `Branch ${String.fromCharCode(64 + state.list.length)}`;
}

function findBranch(state: BranchingState, id: string): Branch | null {
  return state.list.find((branch) => branch.id === id) ?? null;
}

function cloneMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages.map((message) => ({ ...message }));
}

function clampIndex(value: number, max: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.min(Math.floor(value), max);
}

function readNonNegativeInt(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
