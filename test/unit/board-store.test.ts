import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../../src/board/store.js";

describe("BoardStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStoreWithBoardFile(): { store: BoardStore; boardFile: string } {
    const root = mkdtempSync(join(tmpdir(), "forgectl-board-store-"));
    tempDirs.push(root);

    const boardFile = join(root, "board.yaml");
    writeFileSync(boardFile, `
id: demo-board
name: Demo Board
columns: [todo, in-progress, review, done]
transitions:
  todo: [todo, in-progress]
  in-progress: [in-progress, review]
  review: [review, done]
  done: [done]
templates:
  feature:
    source:
      format: yaml
      path: ./pipeline.yaml
    params:
      required: [ticket]
      defaults:
        branch: feature/default
`, "utf-8");

    writeFileSync(join(root, "pipeline.yaml"), `
name: sample
nodes:
  - id: task
    task: "Implement {{ticket}} on {{branch}}"
`, "utf-8");

    return {
      store: new BoardStore(join(root, "state")),
      boardFile,
    };
  }

  it("registers a board and persists cards + run history", async () => {
    const { store, boardFile } = createStoreWithBoardFile();
    const definition = store.readBoardDefinitionFile(boardFile);

    const board = await store.registerBoard(definition, boardFile);
    expect(board.boardId).toBe("demo-board");

    const created = await store.createCard("demo-board", {
      title: "Implement auth",
      type: "feature",
      params: { ticket: "AUTH-1" },
    });
    expect(created.id).toBe("implement-auth");
    expect(created.params.branch).toBe("feature/default");

    await expect(store.updateCard("demo-board", created.id, { column: "done" })).rejects.toThrow(
      /Transition from "todo" to "done" is not allowed/,
    );

    const moved = await store.updateCard("demo-board", created.id, { column: "in-progress" });
    expect(moved.column).toBe("in-progress");

    const started = await store.markRunStarted("demo-board", created.id, "pipe-1", "manual");
    expect(started.runHistory).toHaveLength(1);
    expect(started.runHistory[0].status).toBe("running");

    const completed = await store.markRunCompleted("demo-board", created.id, "pipe-1", "completed", {
      moveToColumn: "review",
      scheduleMinutes: 15,
    });
    expect(completed.column).toBe("review");
    expect(completed.runHistory[0].status).toBe("completed");
    expect(completed.nextScheduledAt).toBeTruthy();

    const persisted = await store.getBoard("demo-board");
    expect(persisted?.cards).toHaveLength(1);
    expect(persisted?.cards[0].runHistory[0].runId).toBe("pipe-1");
  });
});
