#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("vibeqa")
  .description("Run the local VibeQA Alpha-0 CLI.")
  .version("0.0.0")
  .option("--url <url>", "Target website URL")
  .option("--description <description>", "Short product description")
  .option(
    "--mode <mode>",
    "Testing mode: release_check, exploration, or both",
    "exploration"
  )
  .option("--storage-state <path>", "Path to a Playwright storage state file")
  .option("--max-actions <count>", "Maximum browser actions", "40")
  .action(() => {
    program.help({ error: false });
  });

program.parse();
