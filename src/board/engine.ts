import { resolve, dirname } from "node:path";
import type { BoardStore, BoardCard, BoardTemplate, BoardDefinition } from "./store.js";
import { loadTemplatePipeline } from "./template-loader.js";
import type { PipelineDefinition } from "../pipeline/types.js";

interface PipelineServiceLike {
  submitPipeline(pipeline: PipelineDefinition): { id: string; status: string; nodes: Record<string, never> };
  waitFor(runId: string): Promise<{ id: string; status: string }>;
}

interface EngineOptions {
  maxConcurrentCardRuns?: number;
}

export class BoardEngine {
  private store: BoardStore;
  private pipelineService: PipelineServiceLike;
  private maxConcurrentCardRuns: number;
  private definitions = new Map<string, { definition: BoardDefinition; definitionPath: string }>();

  constructor(store: BoardStore, pipelineService: PipelineServiceLike, options?: EngineOptions) {
    this.store = store;
    this.pipelineService = pipelineService;
    this.maxConcurrentCardRuns = options?.maxConcurrentCardRuns ?? 2;
  }

  async registerBoardFile(boardPath: string): Promise<void> {
    const definition = this.store.readBoardDefinitionFile(boardPath);
    await this.store.registerBoard(definition, boardPath);
    this.definitions.set(definition.id, { definition, definitionPath: resolve(boardPath) });
  }

  async createCard(
    boardId: string,
    opts: { title: string; type: string; params: Record<string, string> },
  ): Promise<BoardCard> {
    return this.store.createCard(boardId, opts);
  }

  async updateCard(
    boardId: string,
    cardId: string,
    update: { column?: string },
  ): Promise<BoardCard> {
    const card = await this.store.updateCard(boardId, cardId, update);

    // Auto-trigger on column enter
    if (update.column) {
      const def = this.definitions.get(boardId);
      if (def) {
        const board = await this.store.getBoard(boardId);
        const cardData = board?.cards.find((c) => c.id === cardId);
        if (cardData) {
          const template = def.definition.templates?.[cardData.type];
          if (template?.triggers?.auto_on_enter?.includes(update.column)) {
            await this.triggerCardRun(boardId, cardId, "auto");
          }
        }
      }
    }

    return card;
  }

  async triggerCardRun(
    boardId: string,
    cardId: string,
    triggerMode: string,
  ): Promise<{ runId: string }> {
    const board = await this.store.getBoard(boardId);
    if (!board) throw new Error(`Board ${boardId} not found`);

    const card = board.cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    const def = this.definitions.get(boardId);
    if (!def) throw new Error(`Board definition ${boardId} not registered`);

    const template = def.definition.templates?.[card.type];
    if (!template) throw new Error(`Template ${card.type} not found`);

    const pipeline = this.buildPipeline(template, card.params, def.definitionPath);
    const submitted = this.pipelineService.submitPipeline(pipeline);

    await this.store.markRunStarted(boardId, cardId, submitted.id, triggerMode);

    // Reconcile in background
    void this.reconcileRun(boardId, cardId, submitted.id, template);

    return { runId: submitted.id };
  }

  private buildPipeline(
    template: BoardTemplate,
    params: Record<string, string>,
    definitionPath: string,
  ): PipelineDefinition {
    const loaded = loadTemplatePipeline(template, params, definitionPath);
    return loaded.pipeline;
  }

  private async reconcileRun(
    boardId: string,
    cardId: string,
    runId: string,
    template: BoardTemplate,
  ): Promise<void> {
    try {
      const result = await this.pipelineService.waitFor(runId);
      const status = result.status === "completed" ? "completed" : "failed";

      const moveToColumn = status === "completed"
        ? template.post_run?.on_success
        : template.post_run?.on_failure;

      const scheduleMinutes = template.triggers?.schedule?.enabled
        ? template.triggers.schedule.interval_minutes
        : undefined;

      await this.store.markRunCompleted(boardId, cardId, runId, status, {
        moveToColumn,
        scheduleMinutes,
      });
    } catch {
      await this.store.markRunCompleted(boardId, cardId, runId, "failed");
    }
  }

  async schedulerTick(now: Date): Promise<{ triggered: Array<{ boardId: string; cardId: string; runId: string }> }> {
    const triggered: Array<{ boardId: string; cardId: string; runId: string }> = [];

    for (const [boardId, def] of this.definitions) {
      const board = await this.store.getBoard(boardId);
      if (!board) continue;

      for (const card of board.cards) {
        if (!card.nextScheduledAt) continue;
        if (new Date(card.nextScheduledAt) > now) continue;

        // Check no active run
        const hasActiveRun = card.runHistory.some((r) => r.status === "running");
        if (hasActiveRun) continue;

        const template = def.definition.templates?.[card.type];
        if (!template?.triggers?.schedule?.enabled) continue;

        const result = await this.triggerCardRun(boardId, card.id, "scheduled");
        triggered.push({ boardId, cardId: card.id, runId: result.runId });

        // Clear the schedule time
        card.nextScheduledAt = undefined;
      }
    }

    return { triggered };
  }
}
