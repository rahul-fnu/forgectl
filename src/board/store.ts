import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import {
  BoardDefinitionSchema,
  CreateCardSchema,
  UpdateCardSchema,
  type BoardDefinitionInput,
} from "./schema.js";
import type {
  BoardCard,
  BoardDefinition,
  BoardRegistry,
  BoardState,
  BoardSummary,
  TriggerMode,
} from "./types.js";

const DEFAULT_BOARD_STATE_DIR = "~/.forgectl/board";

interface LockHandle {
  release: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function expandHome(pathValue: string): string {
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  if (pathValue === "~") {
    return homedir();
  }
  return pathValue;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultTransitions(columns: string[]): Record<string, string[]> {
  const transitions: Record<string, string[]> = {};
  for (const column of columns) {
    transitions[column] = [...columns];
  }
  return transitions;
}

function normalizeTransitions(
  columns: string[],
  transitions?: Record<string, string[]>,
): Record<string, string[]> {
  const base = defaultTransitions(columns);
  if (!transitions) return base;
  for (const [from, toList] of Object.entries(transitions)) {
    if (!columns.includes(from)) continue;
    const filtered = toList.filter((to) => columns.includes(to));
    base[from] = filtered.length > 0 ? filtered : [...columns];
  }
  return base;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

export class BoardStore {
  private readonly stateDir: string;
  private readonly registryFile: string;
  private readonly statesDir: string;
  private readonly locksDir: string;

  constructor(stateDir = DEFAULT_BOARD_STATE_DIR) {
    this.stateDir = resolve(expandHome(stateDir));
    this.registryFile = join(this.stateDir, "registry.json");
    this.statesDir = join(this.stateDir, "states");
    this.locksDir = join(this.stateDir, "locks");
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.statesDir, { recursive: true });
    mkdirSync(this.locksDir, { recursive: true });
  }

  getStateDir(): string {
    return this.stateDir;
  }

  readBoardDefinitionFile(filePath: string): BoardDefinition {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Board definition file not found: ${resolvedPath}`);
    }
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = parseYaml(raw);
    const definition = BoardDefinitionSchema.parse(parsed) as BoardDefinitionInput;
    this.validateDefinition(definition);
    return deepCopy(definition as BoardDefinition);
  }

  async listBoards(): Promise<BoardSummary[]> {
    const registry = this.loadRegistry();
    return [...registry.boards].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getBoard(boardId: string): Promise<BoardState | null> {
    const filePath = this.boardStatePath(boardId);
    if (!existsSync(filePath)) return null;
    return deepCopy(this.loadBoardState(boardId));
  }

  async getAllBoards(): Promise<BoardState[]> {
    const registry = this.loadRegistry();
    const boards: BoardState[] = [];
    for (const summary of registry.boards) {
      const filePath = this.boardStatePath(summary.id);
      if (!existsSync(filePath)) continue;
      boards.push(this.loadBoardState(summary.id));
    }
    return boards;
  }

  async registerBoard(definition: BoardDefinition, definitionPath: string): Promise<BoardState> {
    const normalizedDefinition = BoardDefinitionSchema.parse(definition) as BoardDefinitionInput;
    this.validateDefinition(normalizedDefinition);
    const resolvedDefinitionPath = resolve(definitionPath);
    const lock = await this.acquireLock("registry");
    try {
      const now = new Date().toISOString();
      const registry = this.loadRegistry();
      const existingSummary = registry.boards.find((item) => item.id === normalizedDefinition.id);
      const existingState = existsSync(this.boardStatePath(normalizedDefinition.id))
        ? this.loadBoardState(normalizedDefinition.id)
        : null;

      const nextState: BoardState = {
        boardId: normalizedDefinition.id,
        boardName: normalizedDefinition.name,
        definitionPath: resolvedDefinitionPath,
        columns: [...normalizedDefinition.columns],
        transitions: normalizeTransitions(normalizedDefinition.columns, normalizedDefinition.transitions),
        templates: deepCopy(normalizedDefinition.templates),
        cards: existingState ? this.reconcileCards(existingState.cards, normalizedDefinition.columns) : [],
        createdAt: existingState?.createdAt ?? now,
        updatedAt: now,
      };

      this.writeBoardState(nextState);

      if (existingSummary) {
        existingSummary.name = normalizedDefinition.name;
        existingSummary.definitionPath = resolvedDefinitionPath;
        existingSummary.updatedAt = now;
      } else {
        registry.boards.push({
          id: normalizedDefinition.id,
          name: normalizedDefinition.name,
          definitionPath: resolvedDefinitionPath,
          createdAt: now,
          updatedAt: now,
        });
      }
      this.saveRegistry(registry);
      return deepCopy(nextState);
    } finally {
      lock.release();
    }
  }

  async createCard(boardId: string, input: {
    id?: string;
    title: string;
    type: string;
    column?: string;
    params?: Record<string, string | number | boolean>;
    depends_on?: string[];
  }): Promise<BoardCard> {
    const payload = CreateCardSchema.parse(input);
    const lock = await this.acquireLock(boardId);
    try {
      const board = this.loadBoardState(boardId);
      const template = board.templates[payload.type];
      if (!template) {
        throw new Error(`Unknown card type "${payload.type}"`);
      }

      const now = new Date().toISOString();
      const id = payload.id ?? this.generateCardId(board, payload.title);
      if (board.cards.some((card) => card.id === id)) {
        throw new Error(`Card with id "${id}" already exists`);
      }

      const column = payload.column ?? board.columns[0];
      if (!board.columns.includes(column)) {
        throw new Error(`Invalid column "${column}"`);
      }

      const params = {
        ...(template.params?.defaults ?? {}),
        ...(payload.params ?? {}),
      };

      this.validateRequiredParams(template.params?.required ?? [], params);

      // Validate depends_on references
      const cardIds = new Set(board.cards.map(c => c.id));
      for (const depId of payload.depends_on ?? []) {
        if (!cardIds.has(depId)) {
          throw new Error(`depends_on references unknown card "${depId}"`);
        }
      }

      const card: BoardCard = {
        id,
        title: payload.title,
        type: payload.type,
        column,
        params,
        depends_on: (payload.depends_on ?? []).length > 0 ? payload.depends_on : undefined,
        createdAt: now,
        updatedAt: now,
        statusVersion: 1,
        nextScheduledAt: this.computeInitialNextScheduledAt(template),
        runHistory: [],
      };
      board.cards.push(card);
      board.updatedAt = now;
      this.writeBoardState(board);
      return deepCopy(card);
    } finally {
      lock.release();
    }
  }

  async updateCard(boardId: string, cardId: string, patch: {
    title?: string;
    column?: string;
    params?: Record<string, string | number | boolean>;
  }): Promise<BoardCard> {
    const payload = UpdateCardSchema.parse(patch);
    const lock = await this.acquireLock(boardId);
    try {
      const board = this.loadBoardState(boardId);
      const card = board.cards.find((entry) => entry.id === cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found`);
      }
      const template = board.templates[card.type];
      if (!template) {
        throw new Error(`Card type "${card.type}" is no longer configured`);
      }

      if (payload.title !== undefined) {
        card.title = payload.title;
      }
      if (payload.params !== undefined) {
        card.params = { ...(template.params?.defaults ?? {}), ...payload.params };
      }
      if (payload.column !== undefined) {
        this.assertTransitionAllowed(board, card.column, payload.column);
        if (card.column !== payload.column) {
          card.column = payload.column;
          card.statusVersion += 1;
        }
      }

      this.validateRequiredParams(template.params?.required ?? [], card.params);
      card.updatedAt = new Date().toISOString();
      board.updatedAt = card.updatedAt;
      this.writeBoardState(board);
      return deepCopy(card);
    } finally {
      lock.release();
    }
  }

  async markRunStarted(
    boardId: string,
    cardId: string,
    runId: string,
    mode: TriggerMode,
  ): Promise<BoardCard> {
    const lock = await this.acquireLock(boardId);
    try {
      const board = this.loadBoardState(boardId);
      const card = board.cards.find((entry) => entry.id === cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found`);
      }

      const active = card.runHistory.find((run) => run.status === "running");
      if (active) {
        throw new Error(`Card "${cardId}" already has an active run (${active.runId})`);
      }

      const now = new Date().toISOString();
      card.runHistory.push({
        runId,
        triggerMode: mode,
        status: "running",
        statusVersion: card.statusVersion,
        createdAt: now,
      });
      if (mode === "auto") {
        card.lastAutoTriggeredVersion = card.statusVersion;
      }
      card.updatedAt = now;
      board.updatedAt = now;
      this.writeBoardState(board);
      return deepCopy(card);
    } finally {
      lock.release();
    }
  }

  async markRunCompleted(
    boardId: string,
    cardId: string,
    runId: string,
    status: "completed" | "failed",
    options: {
      moveToColumn?: string;
      error?: string;
      scheduleMinutes?: number;
    } = {},
  ): Promise<BoardCard> {
    const lock = await this.acquireLock(boardId);
    try {
      const board = this.loadBoardState(boardId);
      const card = board.cards.find((entry) => entry.id === cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found`);
      }

      const run = card.runHistory.find((entry) => entry.runId === runId);
      if (!run) {
        throw new Error(`Run "${runId}" not attached to card "${cardId}"`);
      }

      const now = new Date().toISOString();
      run.status = status;
      run.completedAt = now;
      run.error = options.error;

      if (options.moveToColumn && board.columns.includes(options.moveToColumn)) {
        if (card.column !== options.moveToColumn) {
          const allowed = board.transitions[card.column] ?? board.columns;
          if (allowed.includes(options.moveToColumn)) {
            card.column = options.moveToColumn;
            card.statusVersion += 1;
          }
        }
      }

      if (options.scheduleMinutes && options.scheduleMinutes > 0) {
        card.nextScheduledAt = new Date(Date.now() + options.scheduleMinutes * 60_000).toISOString();
      }

      card.updatedAt = now;
      board.updatedAt = now;
      this.writeBoardState(board);
      return deepCopy(card);
    } finally {
      lock.release();
    }
  }

  async setNextScheduledAt(boardId: string, cardId: string, nextScheduledAt: string): Promise<void> {
    const lock = await this.acquireLock(boardId);
    try {
      const board = this.loadBoardState(boardId);
      const card = board.cards.find((entry) => entry.id === cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found`);
      }
      card.nextScheduledAt = nextScheduledAt;
      card.updatedAt = new Date().toISOString();
      board.updatedAt = card.updatedAt;
      this.writeBoardState(board);
    } finally {
      lock.release();
    }
  }

  private validateDefinition(definition: {
    id: string;
    columns: string[];
    templates: Record<string, BoardDefinitionInput["templates"][string]>;
  }): void {
    const columns = new Set(definition.columns);
    if (columns.size !== definition.columns.length) {
      throw new Error(`Board "${definition.id}" has duplicate columns`);
    }

    for (const [type, template] of Object.entries(definition.templates)) {
      if (template.post_run?.on_success && !columns.has(template.post_run.on_success)) {
        throw new Error(`Template "${type}" references unknown on_success column "${template.post_run.on_success}"`);
      }
      if (template.post_run?.on_failure && !columns.has(template.post_run.on_failure)) {
        throw new Error(`Template "${type}" references unknown on_failure column "${template.post_run.on_failure}"`);
      }
      for (const column of template.triggers?.auto_on_enter ?? []) {
        if (!columns.has(column)) {
          throw new Error(`Template "${type}" references unknown auto_on_enter column "${column}"`);
        }
      }
    }
  }

  private reconcileCards(cards: BoardCard[], allowedColumns: string[]): BoardCard[] {
    const defaultColumn = allowedColumns[0];
    return cards.map((card) => {
      if (allowedColumns.includes(card.column)) return card;
      return {
        ...card,
        column: defaultColumn,
        statusVersion: card.statusVersion + 1,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private computeInitialNextScheduledAt(template: BoardDefinition["templates"][string]): string | undefined {
    const schedule = template.triggers?.schedule;
    if (!schedule?.enabled) return undefined;
    const minutes = schedule.interval_minutes ?? 60;
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }

  private validateRequiredParams(required: string[], params: Record<string, unknown>): void {
    for (const key of required) {
      if (!(key in params)) {
        throw new Error(`Missing required card param: ${key}`);
      }
    }
  }

  private assertTransitionAllowed(board: BoardState, from: string, to: string): void {
    if (!board.columns.includes(to)) {
      throw new Error(`Invalid column "${to}"`);
    }

    const allowed = board.transitions[from] ?? board.columns;
    if (!allowed.includes(to)) {
      throw new Error(`Transition from "${from}" to "${to}" is not allowed`);
    }
  }

  private generateCardId(board: BoardState, title: string): string {
    const base = slugify(title);
    const taken = new Set(board.cards.map((card) => card.id));
    if (!taken.has(base)) return base;
    let idx = 2;
    while (taken.has(`${base}-${idx}`)) {
      idx += 1;
    }
    return `${base}-${idx}`;
  }

  private boardStatePath(boardId: string): string {
    return join(this.statesDir, `${boardId}.json`);
  }

  private loadRegistry(): BoardRegistry {
    if (!existsSync(this.registryFile)) {
      return { boards: [] };
    }
    const parsed = JSON.parse(readFileSync(this.registryFile, "utf-8")) as BoardRegistry;
    if (!parsed.boards || !Array.isArray(parsed.boards)) {
      return { boards: [] };
    }
    return parsed;
  }

  private saveRegistry(registry: BoardRegistry): void {
    this.atomicWriteJson(this.registryFile, registry);
  }

  private loadBoardState(boardId: string): BoardState {
    const filePath = this.boardStatePath(boardId);
    if (!existsSync(filePath)) {
      throw new Error(`Board "${boardId}" is not registered`);
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as BoardState;
    return parsed;
  }

  private writeBoardState(state: BoardState): void {
    this.atomicWriteJson(this.boardStatePath(state.boardId), state);
  }

  private atomicWriteJson(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const temp = join(dirname(filePath), `.${basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    renameSync(temp, filePath);
  }

  private async acquireLock(key: string, timeoutMs = 5000): Promise<LockHandle> {
    const lockPath = join(this.locksDir, `${key}.lock`);
    const started = Date.now();

    while (true) {
      try {
        const fd = openSync(lockPath, "wx");
        return {
          release: () => {
            try {
              closeSync(fd);
            } finally {
              try {
                unlinkSync(lockPath);
              } catch {
                // ignore cleanup errors
              }
            }
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        if (Date.now() - started > timeoutMs) {
          throw new Error(`Timed out waiting for board lock: ${key}`);
        }
        await sleep(50);
      }
    }
  }
}

export function resolveBoardStateDir(configValue?: string): string {
  return resolve(expandHome(configValue || DEFAULT_BOARD_STATE_DIR));
}
