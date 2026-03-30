export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskNode {
  id: string;
  issueId: string;
  dependsOn: string[];
  status: TaskStatus;
}

export class SimpleDAG {
  private nodes: Map<string, TaskNode> = new Map();

  addNode(node: Omit<TaskNode, "status">): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Duplicate node ID: "${node.id}"`);
    }
    this.nodes.set(node.id, { ...node, status: "pending" });
  }

  validate(): string[] {
    const errors: string[] = [];
    for (const [id, node] of this.nodes) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep)) {
          errors.push(`Node "${id}" depends on unknown node "${dep}"`);
        }
      }
    }
    if (errors.length > 0) return errors;

    // Cycle detection via DFS
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      for (const dep of this.nodes.get(id)!.dependsOn) {
        if (color.get(dep) === GRAY) {
          errors.push(`Cycle detected involving "${dep}"`);
          return true;
        }
        if (color.get(dep) === WHITE && dfs(dep)) return true;
      }
      color.set(id, BLACK);
      return false;
    };

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE && dfs(id)) break;
    }

    return errors;
  }

  getReady(): TaskNode[] {
    const ready: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.status !== "pending") continue;
      const depsReady = node.dependsOn.every(
        (dep) => this.nodes.get(dep)?.status === "done",
      );
      if (depsReady) ready.push(node);
    }
    return ready;
  }

  markRunning(id: string): void {
    const node = this.getNode(id);
    if (node.status !== "pending") {
      throw new Error(`Cannot mark "${id}" running: status is "${node.status}"`);
    }
    node.status = "running";
  }

  markDone(id: string): void {
    const node = this.getNode(id);
    if (node.status !== "running") {
      throw new Error(`Cannot mark "${id}" done: status is "${node.status}"`);
    }
    node.status = "done";
  }

  markFailed(id: string): void {
    const node = this.getNode(id);
    if (node.status !== "running") {
      throw new Error(`Cannot mark "${id}" failed: status is "${node.status}"`);
    }
    node.status = "failed";
  }

  isComplete(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === "pending" || node.status === "running") return false;
    }
    return true;
  }

  getNode(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node: "${id}"`);
    return node;
  }

  allNodes(): TaskNode[] {
    return [...this.nodes.values()];
  }

  nodeCount(): number {
    return this.nodes.size;
  }
}

/**
 * Execute a SimpleDAG with a callback for each node.
 * Runs nodes in dependency order with configurable parallelism.
 * This is the minimal DAG executor — no conditions, loops, or checkpointing.
 */
export async function executeSimpleDAG(
  dag: SimpleDAG,
  runNode: (node: TaskNode) => Promise<boolean>,
  maxParallel = 1,
): Promise<{ completed: string[]; failed: string[] }> {
  const errors = dag.validate();
  if (errors.length > 0) {
    throw new Error(`Invalid DAG:\n${errors.join("\n")}`);
  }

  const completed: string[] = [];
  const failed: string[] = [];

  while (!dag.isComplete()) {
    const ready = dag.getReady();
    if (ready.length === 0) break;

    const batch = ready.slice(0, maxParallel);
    for (const node of batch) {
      dag.markRunning(node.id);
    }

    const results = await Promise.allSettled(
      batch.map(async (node) => {
        const success = await runNode(node);
        return { id: node.id, success };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          dag.markDone(result.value.id);
          completed.push(result.value.id);
        } else {
          dag.markFailed(result.value.id);
          failed.push(result.value.id);
        }
      } else {
        const id = batch[results.indexOf(result)]?.id;
        if (id) {
          dag.markFailed(id);
          failed.push(id);
        }
      }
    }
  }

  return { completed, failed };
}
