import { ChatOpenRouter } from "@langchain/openrouter";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import dotenv from "dotenv";
import readline from "readline";

dotenv.config();

async function main() {
  const mcpClient = new MultiServerMCPClient({
    // Filesystem
    filesystem: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\sourav", "D:\\"],
    },

    // Supabase
    supabase: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", process.env.SUPABASE_ACCESS_TOKEN],
    },

    // === Browser: Control EXISTING Chrome ===
    browser: {
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--browser=chrome",
        "--extension"           // This connects to your running Chrome
      ],
    },
  });

  const mcpTools = await mcpClient.getTools();
  console.log(`✅ Loaded ${mcpTools.length} MCP tools (Files + Supabase + Existing Chrome)`);

    const llm = new ChatOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: "poolside/laguna-m.1:free",        // Best free agent model
      // model: "openrouter/free",               // Auto best free model
      temperature: 0.1,
    });

  const agent = createReactAgent({
    llm,
    tools: mcpTools,
    messageModifier: `You are an AI assistant with full access to:
- Local filesystem
- Supabase
- User's currently running Chrome browser (with all open tabs, logins, cookies)

You can open new tabs, click, type, scroll, extract text, take screenshots, etc. in the real Chrome.`
  });

  console.log("\n🤖 Agent with Existing Chrome Control Ready!\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const query = await new Promise(resolve => rl.question("You: ", resolve));
    if (query.toLowerCase().trim() === "exit") break;

    console.log("Thinking...");
    try {
      const result = await agent.invoke({ messages: [{ role: "user", content: query }] });
      const last = result.messages[result.messages.length - 1];
      console.log("\nAgent:", last.content);
    } catch (error) {
      console.error("❌ Error:", error.message);
    }
  }

  rl.close();
  await mcpClient.close();
}

main().catch(console.error);