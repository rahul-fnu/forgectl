import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";

export interface BoardDefinition {
  id: string;
  name: string;
  columns: string[];
  transitions?: Record<string, string[]>;
  templates?: Record<string, BoardTemplate>;
}

export interface BoardTemplate {
  source: { format: string; path: string };
  params?: {
    required?: string[];
    defaults?: Record<string, string>;
  };
  triggers?: {
    manual?: boolean;
    auto_on_enter?: string[];
    schedule?: {
      enabled?: boolean;
      interval_minutes?: number;
    };
  };
  post_run?: {
    on_success?: string;
    on_failure?: string;
  };
}

export interface RunHistoryEntry {
  runId: string;
  status: "running" | "completed" | "failed";
  triggerMode: string;
  startedAt: string;
  completedAt?: string;
}

export interface BoardCard {
  id: string;
  title: string;
  type: string;
  column: string;
  params: Record<string, string>;
  runHistory: RunHistoryEntry[];
  nextScheduledAt?: string;
}

export interface BoardState {
  boardId: string;
  definition: BoardDefinition;
  definitionPath: string;
  cards: BoardCard[];
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export class BoardStore {
  private stateDir: string;
  private boards = new Map<string, BoardState>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    this.loadPersistedState();
  }

  private getStatePath(boardId: string): string {
    return join(this.stateDir, `${boardId}.json`);
  }

  private loadPersistedState(): void {
    // Load any previously persisted board states
  }

  private persist(boardId: string): void {
    const state = this.boards.get(boardId);
    if (!state) return;
    const path = this.getStatePath(boardId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  }

  readBoardDefinitionFile(filePath: string): BoardDefinition {
    const content = readFileSync(filePath, "utf-8");
    return yaml.load(content) as BoardDefinition;
  }

  async registerBoard(definition: BoardDefinition, definitionPath: string): Promise<{ boardId: string }> {
    const state: BoardState = {
      boardId: definition.id,
      definition,
      definitionPath: resolve(definitionPath),
      cards: [],
    };
    this.boards.set(definition.id, state);
    this.persist(definition.id);
    return { boardId: definition.id };
  }

  async getBoard(boardId: string): Promise<BoardState | undefined> {
    return this.boards.get(boardId);
  }

  async createCard(
    boardId: string,
    opts: { title: string; type: string; params: Record<string, string> },
  ): Promise<BoardCard> {
    const state = this.boards.get(boardId);
    if (!state) throw new Error(`Board ${boardId} not found`);

    const template = state.definition.templates?.[opts.type];
    const mergedParams = { ...(template?.params?.defaults ?? {}), ...opts.params };

    const card: BoardCard = {
      id: slugify(opts.title),
      title: opts.title,
      type: opts.type,
      column: state.definition.columns[0],
      params: mergedParams,
      runHistory: [],
    };

    state.cards.push(card);
    this.persist(boardId);
    return card;
  }

  async updateCard(
    boardId: string,
    cardId: string,
    update: { column?: string },
  ): Promise<BoardCard> {
    const state = this.boards.get(boardId);
    if (!state) throw new Error(`Board ${boardId} not found`);

    const card = state.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    if (update.column) {
      const transitions = state.definition.transitions;
      if (transitions) {
        const allowed = transitions[card.column];
        if (allowed && !allowed.includes(update.column)) {
          throw new Error(`Transition from "${card.column}" to "${update.column}" is not allowed`);
        }
      }
      card.column = update.column;
    }

    this.persist(boardId);
    return card;
  }

  async markRunStarted(
    boardId: string,
    cardId: string,
    runId: string,
    triggerMode: string,
  ): Promise<BoardCard> {
    const state = this.boards.get(boardId);
    if (!state) throw new Error(`Board ${boardId} not found`);

    const card = state.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    card.runHistory.push({
      runId,
      status: "running",
      triggerMode,
      startedAt: new Date().toISOString(),
    });

    this.persist(boardId);
    return card;
  }

  async markRunCompleted(
    boardId: string,
    cardId: string,
    runId: string,
    status: "completed" | "failed",
    opts?: { moveToColumn?: string; scheduleMinutes?: number },
  ): Promise<BoardCard> {
    const state = this.boards.get(boardId);
    if (!state) throw new Error(`Board ${boardId} not found`);

    const card = state.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    const entry = card.runHistory.find((r) => r.runId === runId);
    if (entry) {
      entry.status = status;
      entry.completedAt = new Date().toISOString();
    }

    if (opts?.moveToColumn) {
      card.column = opts.moveToColumn;
    }

    if (opts?.scheduleMinutes) {
      card.nextScheduledAt = new Date(Date.now() + opts.scheduleMinutes * 60_000).toISOString();
    }

    this.persist(boardId);
    return card;
  }

  async setNextScheduledAt(boardId: string, cardId: string, isoDate: string): Promise<void> {
    const state = this.boards.get(boardId);
    if (!state) throw new Error(`Board ${boardId} not found`);

    const card = state.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    card.nextScheduledAt = isoDate;
    this.persist(boardId);
  }
}
