
import { createDeepAgent } from "deepagents";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { LocalShellBackend } from "deepagents";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createMiddleware } from "langchain";
import dotenv from "dotenv";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

async function main() {
  console.log("🚀 Deep Agent Ready for Global Package Installation Test");

  const mcpClient = new MultiServerMCPClient({
    filesystem: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\sourav", "D:\\"] },
    supabase: { transport: "stdio", command: "npx", args: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", process.env.SUPABASE_ACCESS_TOKEN] },
    browser: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--browser=chrome", "--extension"] },
  });

  let mcpTools = await mcpClient.getTools();
  const conflicting = new Set(["read_file", "write_file", "edit_file", "list_directory", "ls"]);
  mcpTools = mcpTools.filter(tool => !conflicting.has(tool.name || tool.tool?.name));

  const backend = new LocalShellBackend({
    workingDirectory: process.cwd(),
    timeout: 180,           // Longer timeout for global installs
  });

  const loggingMiddleware = createMiddleware({
    name: "ShellLoggingMiddleware",
    wrapToolCall: async (request, handler) => {
      const { name, args } = request.toolCall;
      console.log(`\n🔧 [TOOL] ${name}`);
      if (args?.command) console.log(`🚀 [SHELL] ${args.command}`);

      const result = await handler(request);

      console.log(`✅ [RESULT] ${name}`);
      if (result) console.log(typeof result === "string" ? result : JSON.stringify(result));
      return result;
    },
  });

  const llm = new ChatOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "poolside/laguna-m.1:free",
    temperature: 0.1,
  });

  const agent = await createDeepAgent({
    model: llm,
    systemPrompt: `You are a powerful local AI assistant with full shell access on the user's PC.

You can run npm install -g for global packages.
After installing, verify using commands like:
- npm list -g --depth=0
- <package-name> --version`,

    tools: mcpTools,
    backend,
    skills: [path.join(__dirname, "skills")],
    middleware: [loggingMiddleware],
  });

  console.log("\n🤖 Agent Ready. Use the test prompt below.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const query = await new Promise(resolve => rl.question("You: ", resolve));
    if (query.toLowerCase().trim() === "exit") break;

    console.log("\nThinking...");
    try {
      const result = await agent.invoke({ messages: [{ role: "user", content: query }] });
      const last = result.messages?.[result.messages.length - 1];
      console.log("\n🤖 Agent:", last?.content || "Done.");
    } catch (error) {
      console.error("❌ Error:", error.message);
    }
  }

  rl.close();
  await mcpClient.close();
}

main().catch(console.error);