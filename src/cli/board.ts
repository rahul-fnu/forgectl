import chalk from "chalk";

const API = "http://127.0.0.1:4856";

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

export async function boardAddCommand(options: { file: string }): Promise<void> {
  const data = await call("/boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: options.file }),
  }) as { boardId: string; boardName: string; columns: string[] };

  console.log(chalk.green(`Board registered: ${data.boardId}`));
  console.log(chalk.gray(`Name: ${data.boardName}`));
  console.log(chalk.gray(`Columns: ${data.columns.join(", ")}`));
}

export async function boardListCommand(): Promise<void> {
  const boards = await call("/boards") as Array<{ id: string; name: string; definitionPath: string }>;
  if (boards.length === 0) {
    console.log("No boards registered.");
    return;
  }
  for (const board of boards) {
    console.log(`${board.id}  ${board.name}`);
    console.log(chalk.gray(`  ${board.definitionPath}`));
  }
}

export async function boardShowCommand(options: { board: string }): Promise<void> {
  const board = await call(`/boards/${options.board}`);
  console.log(JSON.stringify(board, null, 2));
}

export async function boardCardCreateCommand(options: {
  board: string;
  title: string;
  type: string;
  params?: string;
  column?: string;
  id?: string;
}): Promise<void> {
  const params = options.params ? JSON.parse(options.params) : {};
  const data = await call(`/boards/${options.board}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: options.id,
      title: options.title,
      type: options.type,
      column: options.column,
      params,
    }),
  }) as { id: string; column: string };

  console.log(chalk.green(`Card created: ${data.id}`));
  console.log(chalk.gray(`Column: ${data.column}`));
}

export async function boardCardMoveCommand(options: {
  board: string;
  card: string;
  to: string;
}): Promise<void> {
  const data = await call(`/boards/${options.board}/cards/${options.card}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column: options.to }),
  }) as { id: string; column: string };
  console.log(chalk.green(`Card moved: ${data.id} -> ${data.column}`));
}

export async function boardCardTriggerCommand(options: {
  board: string;
  card: string;
  mode?: "manual" | "auto" | "scheduled";
}): Promise<void> {
  const data = await call(`/boards/${options.board}/cards/${options.card}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: options.mode ?? "manual" }),
  }) as { runId: string };
  console.log(chalk.green(`Triggered run: ${data.runId}`));
}

export async function boardCardRunsCommand(options: {
  board: string;
  card: string;
}): Promise<void> {
  const runs = await call(`/boards/${options.board}/cards/${options.card}/runs`);
  console.log(JSON.stringify(runs, null, 2));
}
