import { appendFileSync } from "node:fs";

export function makeLogger(component: string, logFile: string) {
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] [${component}] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(logFile, line);
    } catch {}
  };
}

export type Logger = ReturnType<typeof makeLogger>;
