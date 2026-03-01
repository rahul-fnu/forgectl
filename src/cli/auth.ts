import chalk from "chalk";
import { createInterface } from "node:readline";
import { getClaudeAuth, setClaudeApiKey } from "../auth/claude.js";
import { setCodexApiKey } from "../auth/codex.js";
import { listCredentials, deleteCredential } from "../auth/store.js";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export async function authCommand(action: string, provider?: string): Promise<void> {
  if (action === "list") {
    const creds = await listCredentials();
    if (creds.length === 0) {
      console.log(chalk.yellow("No credentials configured. Run `forgectl auth add <provider>`."));
      return;
    }
    console.log(chalk.bold("\nConfigured credentials:\n"));
    for (const { provider: p, key } of creds) {
      console.log(`  ${chalk.green("✔")} ${p} (${key})`);
    }
    console.log();
    return;
  }

  if (action === "add") {
    if (provider === "claude-code") {
      const existing = await getClaudeAuth();
      if (existing?.type === "oauth_session") {
        console.log(chalk.green("✔ Found existing Claude Code OAuth session at ~/.claude/"));
        const override = await prompt("Add an API key anyway? (y/N): ");
        if (override.toLowerCase() !== "y") return;
      }
      const key = await prompt("Enter your Anthropic API key: ");
      if (!key.startsWith("sk-ant-")) {
        console.log(chalk.yellow("Warning: Key doesn't look like an Anthropic API key (expected sk-ant-...)"));
      }
      await setClaudeApiKey(key);
      console.log(chalk.green("✔ Claude Code API key saved."));
    } else if (provider === "codex") {
      const key = await prompt("Enter your OpenAI API key: ");
      await setCodexApiKey(key);
      console.log(chalk.green("✔ Codex (OpenAI) API key saved."));
    } else {
      console.error(chalk.red(`Unknown provider: ${provider}. Use: claude-code | codex`));
      process.exit(1);
    }
    return;
  }

  if (action === "remove") {
    if (!provider) { console.error("Provider required."); process.exit(1); }
    await deleteCredential(provider, "api_key");
    console.log(chalk.green(`✔ Removed credentials for ${provider}.`));
    return;
  }
}
