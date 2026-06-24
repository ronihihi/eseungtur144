import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const host = "0.0.0.0";

const server = app.listen(port, host, () => {
  logger.info(
    {
      host,
      port,
      environment: process.env.NODE_ENV ?? "development",
    },
    "Server listening",
  );
});

server.on("error", (error) => {
  logger.error(
    {
      error,
      host,
      port,
    },
    "Server failed to start",
  );

  process.exit(1);
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "Shutdown signal received");

  server.close((error) => {
    if (error) {
      logger.error({ error }, "Error while closing HTTP server");
      process.exit(1);
    }

    logger.info("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
