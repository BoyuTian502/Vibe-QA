import { startBenchmarkServer } from "./server.js";

const port = Number(process.env.PORT ?? "3000");
const server = await startBenchmarkServer({ port, host: "localhost" });

console.log("");
console.log("=================================");
console.log(" Vibe QA Benchmark Demo Running");
console.log("=================================");
console.log("");
console.log("Open browser:");
console.log(server.url);
console.log("");
console.log("Press CTRL+C to stop");
console.log("");

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});
