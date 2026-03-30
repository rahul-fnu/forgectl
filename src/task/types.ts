import type { z } from "zod";
import type { TaskSpecSchema } from "./schema.js";

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
