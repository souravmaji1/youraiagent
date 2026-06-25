import { createDeepAgent } from "deepagents";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { LocalShellBackend } from "deepagents";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createMiddleware } from "langchain";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

let agent = null;

async function readFrontmatter(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    console.log(`📄 Read ${filePath} - ${content.length} chars`);
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    const body = frontmatterMatch 
      ? content.replace(/^---[\s\S]*?---/, "").trim() 
      : content.trim();

    let fm = {};
    if (frontmatterMatch) {
      const fmText = frontmatterMatch[1];
      fm.name = fmText.match(/name:\s*(.+)/i)?.[1]?.trim() || "";
      fm.description = fmText.match(/description:\s*(.+)/i)?.[1]?.trim() || "";
      fm.version = fmText.match(/version:\s*(\S+)/i)?.[1]?.trim() || "1.0";
    }
    return { content: body, frontmatter: fm };
  } catch (e) {
    console.warn(`⚠️ Failed to read ${filePath}:`, e.message);
    return { content: "", frontmatter: {} };
  }
}

async function loadSubagents() {
  const subagentsDir = path.join(__dirname, "subagents");
  console.log(`🔍 Scanning subagents directory: ${subagentsDir}`);
  
  const subagents = [];

  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    const entries = await fs.readdir(subagentsDir, { withFileTypes: true });
    console.log(`📁 Found ${entries.length} entries in subagents folder`);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      console.log(`📂 Processing subagent: ${entry.name}`);
      const subDir = path.join(subagentsDir, entry.name);
      const mdPath = path.join(subDir, "SUBAGENT.md");

      const { content: systemPrompt, frontmatter } = await readFrontmatter(mdPath);

      // Load skills with descriptions
      const skillsDir = path.join(subDir, "skills");
      let skills = [];
      try {
        await fs.access(skillsDir);
        const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
        console.log(`  └─ Found ${skillEntries.length} skill folders`);

        for (const skillEntry of skillEntries) {
          if (!skillEntry.isDirectory()) continue;
          const skillMd = path.join(skillsDir, skillEntry.name, "SKILL.md");
          const { frontmatter: skillFm } = await readFrontmatter(skillMd);
          
          skills.push({
            name: skillEntry.name,
            description: skillFm.description || `Skill for ${skillEntry.name}`
          });
        }
      } catch (e) {
        console.log(`  └─ No skills or error: ${e.message}`);
      }

      subagents.push({
        name: entry.name,
        description: frontmatter.description || `Specialized agent for ${entry.name} tasks`,
        systemPrompt: systemPrompt || "You are a helpful specialized subagent.",
        skills
      });
    }
  } catch (e) {
    console.error("❌ Error scanning subagents:", e.message);
  }

  console.log(`✅ Loaded ${subagents.length} subagents:`, subagents.map(s => s.name));
  return subagents;
}

async function initializeAgent() {
  console.log("🚀 Initializing Deep Agent with Dynamic Subagents + Skills...");

  const mcpClient = new MultiServerMCPClient({
    filesystem: { 
      transport: "stdio", 
      command: "npx", 
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\sourav", "D:\\"] 
    },
    supabase: { 
      transport: "stdio", 
      command: "npx", 
      args: ["-y", "@supabase/mcp-server-supabase@latest", "--access-token", process.env.SUPABASE_ACCESS_TOKEN] 
    },
    browser: { 
      transport: "stdio", 
      command: "npx", 
      args: ["-y", "@playwright/mcp@latest", "--browser=chrome"] 
    },
  });

  let mcpTools = await mcpClient.getTools().catch(() => []);
  const conflicting = new Set(["read_file", "write_file", "edit_file", "list_directory", "ls"]);
  mcpTools = mcpTools.filter(tool => !conflicting.has(tool.name || tool.tool?.name));

  const backend = new LocalShellBackend({ 
    workingDirectory: process.cwd(), 
    timeout: 180 
  });

  const loggingMiddleware = createMiddleware({
    name: "LoggingMiddleware",
    wrapToolCall: async (request, handler) => {
      console.log(`🔧 Tool: ${request.toolCall.name}`);
      return handler(request);
    },
  });

  const llm = new ChatOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "poolside/laguna-m.1:free",
    temperature: 0.1,
  });

  const subagents = await loadSubagents();

  // Build rich context for the coordinator
  let subagentContext = "=== CURRENTLY LOADED SUBAGENTS ===\n\n";
  if (subagents.length === 0) {
    subagentContext += "No specialized subagents found yet. You can create them using the Studio UI.\n";
  } else {
    subagents.forEach(sa => {
      subagentContext += `- **${sa.name}**: ${sa.description}\n`;
      if (sa.skills && sa.skills.length > 0) {
        subagentContext += `  Skills: ${sa.skills.map(s => s.name).join(", ")}\n`;
      }
      subagentContext += "\n";
    });
  }

  const coordinatorPrompt = `You are a powerful AI coordinator. 
You can handle tasks directly or delegate to specialized subagents.

${subagentContext}

**Delegation Rules**:
- Delegate to a subagent when the task matches its expertise.
- Always be aware of the currently loaded subagents listed above.
- You can use delegation tools (like "task") to launch them.

Answer questions about available subagents accurately based on the list above.`;

  agent = await createDeepAgent({
    model: llm,
    systemPrompt: coordinatorPrompt,
    tools: mcpTools,
    backend,
    skills: [path.join(__dirname, "skills")],
    subagents,
    middleware: [loggingMiddleware],
  });

  console.log(`✅ Agent Ready with ${subagents.length} subagents!`);
}

// ====================== SERVER ======================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/subagents", async (req, res) => {
  const subagents = await loadSubagents();
  res.json(subagents);
});

app.get("/api/subagent/:name", async (req, res) => {
  const name = req.params.name.toLowerCase();
  const dir = path.join(__dirname, "subagents", name);
  const mdPath = path.join(dir, "SUBAGENT.md");

  try {
    const content = await fs.readFile(mdPath, "utf-8");
    const skillsDir = path.join(dir, "skills");
    let skills = [];
    try {
      await fs.access(skillsDir);
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      skills = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {}
    res.json({ content, skills });
  } catch (err) {
    console.error("Load subagent error:", err);
    res.status(404).json({ error: `Subagent '${name}' not found.` });
  }
});

app.post("/api/subagent/:name/update", async (req, res) => {
  const name = req.params.name.toLowerCase();
  const { content } = req.body;
  const dir = path.join(__dirname, "subagents", name);
  const mdPath = path.join(dir, "SUBAGENT.md");

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(mdPath, content);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/subagent/:name/skill", async (req, res) => {
  const name = req.params.name.toLowerCase();
  const { skillName } = req.body;
  if (!skillName) return res.status(400).json({ error: "Skill name required" });

  const skillDir = path.join(__dirname, "subagents", name, "skills", skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  const mdPath = path.join(skillDir, "SKILL.md");

  try {
    await fs.mkdir(skillDir, { recursive: true });
    const stub = `---
name: ${skillName}
description: Skill for ${name} subagent
version: 1.0
---
# ${skillName}
Implement your skill here.`;
    await fs.writeFile(mdPath, stub);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/skills", async (req, res) => {
  const skillList = [];
  try {
    const skillsDir = path.join(__dirname, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) skillList.push(e.name);
  } catch {}
  res.json(skillList);
});

app.post("/api/create-subagent", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const dir = path.join(__dirname, "subagents", safeName);
  const skillsDir = path.join(dir, "skills");

  await fs.mkdir(skillsDir, { recursive: true });

  const stub = `---
name: ${safeName}
description: Specialized agent for ${safeName} tasks.
version: 1.0
---

You are an expert ${safeName} subagent.`;

  await fs.writeFile(path.join(dir, "SUBAGENT.md"), stub);
  res.json({ success: true, name: safeName });
});

app.post("/api/chat", async (req, res) => {
  if (!agent) return res.status(500).json({ error: "Agent not initialized" });
  const { message } = req.body;
  try {
    const result = await agent.invoke({ messages: [{ role: "user", content: message }] });
    const lastMsg = result.messages?.[result.messages.length - 1];
    res.json({ response: lastMsg?.content || "Done." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const wss = new WebSocketServer({ port: 8080 });
wss.on("connection", () => console.log("Client connected"));

async function startServer() {
  await initializeAgent();
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`🌐 Running at: http://localhost:${PORT}`);
    console.log(`📁 Subagents folder: ${path.join(__dirname, "subagents")}`);
  });
}

startServer().catch(console.error);