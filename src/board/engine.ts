import { resolve } from "node:path";
import { loadTemplatePipeline } from "./template-loader.js";
import { BoardStore } from "./store.js";
import type { BoardCard, BoardState, TriggerMode } from "./types.js";
import type { PipelineRunService } from "../daemon/pipeline-service.js";

export class BoardEngine {
  private readonly store: BoardStore;
  private readonly pipelineService: PipelineRunService;
  private readonly maxConcurrentCardRuns: number;

  constructor(store: BoardStore, pipelineService: PipelineRunService, options?: { maxConcurrentCardRuns?: number }) {
    this.store = store;
    this.pipelineService = pipelineService;
    this.maxConcurrentCardRuns = options?.maxConcurrentCardRuns ?? 2;
  }

  async registerBoardFile(filePath: string): Promise<BoardState> {
    const resolved = resolve(filePath);
    const definition = this.store.readBoardDefinitionFile(resolved);
    return this.store.registerBoard(definition, resolved);
  }

  async listBoards(): Promise<BoardState[]> {
    return this.store.getAllBoards();
  }

  async getBoard(boardId: string): Promise<BoardState | null> {
    return this.store.getBoard(boardId);
  }

  async createCard(boardId: string, input: {
    id?: string;
    title: string;
    type: string;
    column?: string;
    params?: Record<string, string | number | boolean>;
  }): Promise<BoardCard> {
    const card = await this.store.createCard(boardId, input);
    await this.maybeAutoTrigger(boardId, card);
    return card;
  }

  async updateCard(boardId: string, cardId: string, patch: {
    title?: string;
    column?: string;
    params?: Record<string, string | number | boolean>;
  }): Promise<BoardCard> {
    const card = await this.store.updateCard(boardId, cardId, patch);
    if (patch.column !== undefined) {
      await this.maybeAutoTrigger(boardId, card);
    }
    return card;
  }

  async triggerCardRun(boardId: string, cardId: string, mode: TriggerMode = "manual"): Promise<{ runId: string }> {
    const board = await this.store.getBoard(boardId);
    if (!board) {
      throw new Error(`Board "${boardId}" not found`);
    }

    const card = board.cards.find((item) => item.id === cardId);
    if (!card) {
      throw new Error(`Card "${cardId}" not found`);
    }

    this.assertConcurrentRunBudget(board);
    this.assertTriggerAllowed(board, card, mode);
    this.assertDependenciesMet(board, card);

    const template = board.templates[card.type];
    const loaded = loadTemplatePipeline(template, card.params, board.definitionPath);
    const submitted = this.pipelineService.submitPipeline(loaded.pipeline, {
      repo: loaded.pipeline.defaults?.repo,
    });

    await this.store.markRunStarted(boardId, cardId, submitted.id, mode);
    void this.awaitCompletion(board, card.id, submitted.id);
    return { runId: submitted.id };
  }

  async schedulerTick(now = new Date()): Promise<{ triggered: string[] }> {
    const boards = await this.store.getAllBoards();
    const triggered: string[] = [];

    for (const board of boards) {
      // Sort cards in DAG order: cards with no dependencies first,
      // then cards whose dependencies are all completed
      const sortedCards = this.topologicalSortCards(board.cards);

      for (const card of sortedCards) {
        const template = board.templates[card.type];
        const schedule = template?.triggers?.schedule;
        if (!schedule?.enabled) continue;

        const intervalMinutes = schedule.interval_minutes ?? 60;
        const next = card.nextScheduledAt ? new Date(card.nextScheduledAt) : null;
        if (!next || Number.isNaN(next.getTime())) {
          const nextAt = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
          await this.store.setNextScheduledAt(board.boardId, card.id, nextAt);
          continue;
        }

        if (next.getTime() > now.getTime()) continue;

        if (card.runHistory.some((entry) => entry.status === "running")) {
          const nextAt = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
          await this.store.setNextScheduledAt(board.boardId, card.id, nextAt);
          continue;
        }

        // Skip cards whose dependencies haven't completed
        if (!this.areDependenciesMet(board, card)) {
          continue;
        }

        try {
          const result = await this.triggerCardRun(board.boardId, card.id, "scheduled");
          triggered.push(`${board.boardId}:${card.id}:${result.runId}`);
        } catch {
          const nextAt = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
          await this.store.setNextScheduledAt(board.boardId, card.id, nextAt);
        }
      }
    }

    return { triggered };
  }

  private async maybeAutoTrigger(boardId: string, card: BoardCard): Promise<void> {
    const board = await this.store.getBoard(boardId);
    if (!board) return;

    const freshCard = board.cards.find((item) => item.id === card.id);
    if (!freshCard) return;

    const template = board.templates[freshCard.type];
    const autoColumns = template?.triggers?.auto_on_enter ?? [];
    if (!autoColumns.includes(freshCard.column)) return;
    if (freshCard.lastAutoTriggeredVersion === freshCard.statusVersion) return;

    try {
      await this.triggerCardRun(boardId, freshCard.id, "auto");
    } catch {
      // keep card move successful even if auto trigger fails; error is visible via API retries
    }
  }

  /**
   * Check if a card's dependency cards have all completed their latest run.
   */
  private areDependenciesMet(board: BoardState, card: BoardCard): boolean {
    if (!card.depends_on || card.depends_on.length === 0) return true;

    for (const depId of card.depends_on) {
      const depCard = board.cards.find((c) => c.id === depId);
      if (!depCard) return false;
      const lastRun = depCard.runHistory[depCard.runHistory.length - 1];
      if (!lastRun || lastRun.status !== "completed") return false;
    }
    return true;
  }

  /**
   * Assert that a card's dependencies are met before triggering.
   */
  private assertDependenciesMet(board: BoardState, card: BoardCard): void {
    if (!card.depends_on || card.depends_on.length === 0) return;

    const unmet: string[] = [];
    for (const depId of card.depends_on) {
      const depCard = board.cards.find((c) => c.id === depId);
      if (!depCard) {
        unmet.push(`${depId} (not found)`);
        continue;
      }
      const lastRun = depCard.runHistory[depCard.runHistory.length - 1];
      if (!lastRun || lastRun.status !== "completed") {
        unmet.push(depId);
      }
    }
    if (unmet.length > 0) {
      throw new Error(`Card "${card.id}" has unmet dependencies: ${unmet.join(", ")}`);
    }
  }

  /**
   * Topological sort of cards based on depends_on. Cards with no deps come first.
   * Falls back to original order if there are cycles.
   */
  private topologicalSortCards(cards: BoardCard[]): BoardCard[] {
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const card of cards) {
      inDegree.set(card.id, (card.depends_on ?? []).length);
      if (!dependents.has(card.id)) dependents.set(card.id, []);
      for (const dep of card.depends_on ?? []) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(card.id);
      }
    }

    const queue: string[] = [];
    for (const card of cards) {
      if (inDegree.get(card.id) === 0) queue.push(card.id);
    }

    const sorted: BoardCard[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const card = cardMap.get(id);
      if (card) sorted.push(card);
      for (const depId of dependents.get(id) ?? []) {
        const deg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, deg);
        if (deg === 0) queue.push(depId);
      }
    }

    // If not all cards were sorted (cycle), return original order
    return sorted.length === cards.length ? sorted : cards;
  }

  private assertConcurrentRunBudget(board: BoardState): void {
    const active = board.cards.flatMap((card) => card.runHistory).filter((run) => run.status === "running").length;
    if (active >= this.maxConcurrentCardRuns) {
      throw new Error(`Board run capacity reached (${active}/${this.maxConcurrentCardRuns})`);
    }
  }

  private assertTriggerAllowed(board: BoardState, card: BoardCard, mode: TriggerMode): void {
    const template = board.templates[card.type];
    if (!template) {
      throw new Error(`Template "${card.type}" not found`);
    }

    const active = card.runHistory.find((run) => run.status === "running");
    if (active) {
      throw new Error(`Card "${card.id}" already has an active run (${active.runId})`);
    }

    if (mode === "manual" && template.triggers?.manual === false) {
      throw new Error(`Manual trigger is disabled for card type "${card.type}"`);
    }
    if (mode === "auto") {
      const allowedColumns = template.triggers?.auto_on_enter ?? [];
      if (!allowedColumns.includes(card.column)) {
        throw new Error(`Auto trigger is not configured for column "${card.column}"`);
      }
    }
    if (mode === "scheduled" && !template.triggers?.schedule?.enabled) {
      throw new Error(`Scheduled trigger is not enabled for card type "${card.type}"`);
    }
  }

  private async awaitCompletion(board: BoardState, cardId: string, runId: string): Promise<void> {
    const template = board.templates[board.cards.find((item) => item.id === cardId)?.type ?? ""];
    const scheduleMinutes = template?.triggers?.schedule?.enabled
      ? (template.triggers.schedule.interval_minutes ?? 60)
      : undefined;

    try {
      const result = await this.pipelineService.waitFor(runId);
      const status = result.status === "completed" ? "completed" : "failed";
      const moveToColumn = this.resolvePostRunColumn(board, template, status);
      await this.store.markRunCompleted(board.boardId, cardId, runId, status, {
        moveToColumn,
        scheduleMinutes,
      });
    } catch (err) {
      const moveToColumn = this.resolvePostRunColumn(board, template, "failed");
      await this.store.markRunCompleted(board.boardId, cardId, runId, "failed", {
        moveToColumn,
        error: err instanceof Error ? err.message : String(err),
        scheduleMinutes,
      });
    }
  }

  private resolvePostRunColumn(
    board: BoardState,
    template: BoardState["templates"][string] | undefined,
    status: "completed" | "failed",
  ): string | undefined {
    if (!template) return undefined;
    const explicit = status === "completed" ? template.post_run?.on_success : template.post_run?.on_failure;
    if (explicit && board.columns.includes(explicit)) {
      return explicit;
    }

    if (status === "completed" && board.columns.includes("review")) {
      return "review";
    }

    if (status === "failed") {
      if (board.columns.includes("in-progress")) return "in-progress";
      if (board.columns.includes("doing")) return "doing";
    }

    return undefined;
  }
}
