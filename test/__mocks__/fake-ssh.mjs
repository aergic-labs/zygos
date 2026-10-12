/*
 * Fake ssh for integration tests. Replaces the real ssh binary so the
 * mux server can be tested without a real remote. Pipes stdin to a
 * local `sh` and pipes stdout/stderr back. Ignores ssh-like argv flags.
 */
import { spawn } from "node:child_process";

const sh = spawn("sh", [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PS1: "", PS2: "" },
});

process.stdin.pipe(sh.stdin);
sh.stdout.pipe(process.stdout);
sh.stderr.pipe(process.stderr);
sh.on("exit", (code) => process.exit(code ?? 0));
process.on("exit", () => sh.kill());