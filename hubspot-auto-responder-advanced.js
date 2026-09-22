#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const CONFIG = {
  hubspotApiKey: process.env.HUBSPOT_API_KEY,
  claudeApiKey: process.env.CLAUDE_API_KEY,
  pollInterval: (parseInt(process.env.POLL_INTERVAL_SECONDS) || 300) * 1000,
  stateFilePath: "./agent-state.json",
  logFilePath: "./agent-log.txt",
  maxRetries: 3,
  retryDelayMs: 2000,
};

const client = new Anthropic();
const hubspotApi = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${CONFIG.hubspotApiKey}`,
    "Content-Type": "application/json",
  },
});

class Logger {
  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = data
      ? `[${timestamp}] ${level}: ${message} ${JSON.stringify(data)}`
      : `[${timestamp}] ${level}: ${message}`;
    console.log(logMessage);
    try {
      fs.appendFileSync(CONFIG.logFilePath, logMessage + "\n");
    } catch (error) {
      console.error("Failed to write to log file:", error.message);
    }
  }

  info(message, data) {
    this.log("INFO", message, data);
  }
  success(message, data) {
    this.log("SUCCESS", message, data);
  }
  warn(message, data) {
    this.log("WARN", message, data);
  }
  error(message, data) {
    this.log("ERROR", message, data);
  }
  debug(message, data) {
    if (process.env.DEBUG === "true") {
      this.log("DEBUG", message, data);
    }
  }
}

const logger = new Logger();

class StateManager {
  constructor() {
    this.state = this.load();
  }

  load() {
    if (fs.existsSync(CONFIG.stateFilePath)) {
      const data = fs.readFileSync(CONFIG.stateFilePath, "utf-8");
      return JSON.parse(data);
    }
    return {
      processedContacts: [],
      failedContacts: [],
      stats: { totalProcessed: 0, totalFailed: 0, totalRetried: 0 },
      lastRun: null,
    };
  }

  save() {
    fs.writeFileSync(CONFIG.stateFilePath, JSON.stringify(this.state, null, 2));
  }

  addProcessed(contactId, email) {
    if (!this.state.processedContacts.includes(contactId)) {
      this.state.processedContacts.push(contactId);
      this.state.stats.totalProcessed++;
      this.save();
    }
  }

  addFailed(contactId, email, error) {
    this.state.failedContacts.push({
      contactId,
      email,
      error,
      timestamp: new Date().toISOString(),
    });
    this.state.stats.totalFailed++;
    this.save();
  }

  isProcessed(contactId) {
    return this.state.processedContacts.includes(contactId);
  }

  updateLastRun() {
    this.state.lastRun = new Date().toISOString();
    this.save();
  }

  getStats() {
    return this.state.stats;
  }
}

const stateManager = new StateManager();

async function withRetry(fn, context = "") {
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        throw error;
      }
      logger.warn(
        `Retry ${attempt}/${CONFIG.maxRetries} for ${context}`,
        { error: error.message }
      );
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.retryDelayMs * attempt)
      );
    }
  }
}

async function fetchRecentFormSubmissions() {
  return withRetry(async () => {
    logger.info("Fetching recent form submissions from Hubspot...");

    const response = await hubspotApi.get("/crm/v3/objects/contacts", {
      params: {
        limit: 100,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: [
          "firstname",
          "lastname",
          "email",
          "phone",
          "lifecyclestage",
          "hs_lead_status",
          "auto_response_sent",
        ],
      },
    });

    const submissions = (response.data.results || []).filter(
      (contact) =>
        contact.properties.email &&
        contact.properties.lifecyclestage === "subscriber"
    );

    logger.debug("Fetched submissions", { count: submissions.length });
    return submissions;
  }, "fetch_submissions");
}

async function generateResponse(contactProperties) {
  const { firstname, lastname, email, phone } = contactProperties;

  return withRetry(async () => {
    logger.info("Generating response for contact", { email });

    const response = await client.messages.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `You are a warm, friendly customer service representative responding to a form submission.
          
Generate a personalized response that:
1. Thanks ${firstname || "them"} for reaching out
2. Acknowledges we received their inquiry
3. Gives a clear expectation for when we'll follow up (e.g., "within 24 hours")
4. Keeps a friendly, conversational tone
5. Includes a warm closing

Keep it to 2-3 sentences max. Be genuine and personable.

Contact info: ${firstname} ${lastname || ""} (${email})`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : null;
    logger.debug("Generated response", { email, responseLength: text?.length });
    return text;
  }, `generate_response_${email}`);
}

async function sendResponseToHubspot(contactId, response, email) {
  return withRetry(async () => {
    logger.info("Sending response to Hubspot", { email });

    await hubspotApi.patch(`/crm/v3/objects/contacts/${contactId}`, {
      properties: {
        auto_response_message: response,
        auto_response_sent: true,
        auto_response_timestamp: new Date().toISOString(),
      },
    });

    logger.success("Response recorded in Hubspot", { email });
    return true;
  }, `send_response_${email}`);
}

async function processContact(contact) {
  const contactId = contact.id;
  const email = contact.properties.email;
  const firstname = contact.properties.firstname || "Valued Customer";

  logger.info("Processing contact", { email, contactId });

  try {
    if (stateManager.isProcessed(contactId)) {
      logger.debug("Contact already processed, skipping", { email });
      return false;
    }

    const response = await generateResponse(contact.properties);
    if (!response) {
      logger.error("Failed to generate response", { email });
      stateManager.addFailed(contactId, email, "Response generation failed");
      return false;
    }

    logger.debug("Generated response preview", {
      email,
      preview: response.substring(0, 100),
    });

    const success = await sendResponseToHubspot(contactId, response, email);
    if (success) {
      stateManager.addProcessed(contactId, email);
      logger.success("Contact processed successfully", { email });
      return true;
    }
  } catch (error) {
    logger.error("Failed to process contact", {
      email,
      error: error.message,
    });
    stateManager.addFailed(contactId, email, error.message);
    return false;
  }

  return false;
}

async function pollCycle() {
  const startTime = Date.now();
  logger.info("========== POLL CYCLE START ==========");

  try {
    const submissions = await fetchRecentFormSubmissions();
    logger.info("Poll results", { submissionsFound: submissions.length });

    let processed = 0;
    let skipped = 0;

    for (const contact of submissions) {
      if (stateManager.isProcessed(contact.id)) {
        skipped++;
      } else {
        const success = await processContact(contact);
        if (success) {
          processed++;
        }
      }
    }

    stateManager.updateLastRun();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    logger.success("Poll cycle complete", {
      processed,
      skipped,
      durationSeconds: duration,
    });

    const stats = stateManager.getStats();
    logger.info("Cumulative stats", stats);
  } catch (error) {
    logger.error("Fatal error during poll cycle", { error: error.message });
  }

  logger.info("========== POLL CYCLE END ==========\n");
}

async function start() {
  console.log("\n╔═══════════════════════════════════════════╗");
  console.log("║  🤖  Hubspot Auto-Responder Agent         ║");
  console.log("║      Powered by Claude                    ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  logger.info("Agent starting...");
  logger.info("Configuration", {
    pollIntervalSeconds: CONFIG.pollInterval / 1000,
    maxRetries: CONFIG.maxRetries,
    hasHubspotKey: !!CONFIG.hubspotApiKey,
    hasClaudeKey: !!CONFIG.claudeApiKey,
  });

  if (!CONFIG.hubspotApiKey || !CONFIG.claudeApiKey) {
    logger.error("Missing required environment variables");
    console.error(
      "\n❌ Error: HUBSPOT_API_KEY and CLAUDE_API_KEY must be set"
    );
    console.error("\nSetup instructions:");
    console.error("1. Go to Railway dashboard");
    console.error("2. Add your API keys to Variables");
    console.error("3. Save and redeploy\n");
    process.exit(1);
  }

  logger.success(
    "Agent initialized and ready to monitor form submissions!"
  );

  await pollCycle();

  const pollInterval = setInterval(pollCycle, CONFIG.pollInterval);

  console.log(`✅ Agent is now monitoring for new form submissions`);
  console.log(
    `📋 Will check every ${CONFIG.pollInterval / 1000} seconds\n`
  );

  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down gracefully...");
    clearInterval(pollInterval);
    const stats = stateManager.getStats();
    logger.info("Agent shutdown", stats);
    process.exit(0);
  });
}

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection", {
    reason: reason?.message || String(reason),
  });
});

start().catch((error) => {
  logger.error("Failed to start agent", { error: error.message });
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
