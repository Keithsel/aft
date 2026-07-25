import { spawn } from "node:child_process";

/**
 * Ad-hoc sign and warm a binary the test suite is about to spawn repeatedly.
 *
 * macOS assesses an executable's Gatekeeper/XProtect status once per inode. A
 * binary cargo just relinked is a brand-new inode, so its first exec pays the
 * full assessment. Measured on this repo's debug binary, relinking before each
 * sample: unsigned cold exec 3.7s and 5.2s, with one 88.7s outlier; ad-hoc
 * signed cold exec 1.1s and 1.3s; already-assessed inode 8ms. e2e tests spawn
 * the binary under a short per-spawn timeout, so a cold exec reads as a hang
 * and takes the whole suite with it — this repo lost two full TS-suite runs to
 * exactly that, and the outlier shows the tail is unbounded under load.
 *
 * Both steps earn their place: signing cuts the assessment several-fold, and
 * the throwaway exec absorbs what remains, leaving timed spawns at warm cost.
 * Both are best-effort — this is a latency remedy, not a correctness gate, so
 * every failure path is swallowed and callers treat it as advisory.
 *
 * No-op off Darwin. Cheap to repeat — warming an already-warm inode is a few ms.
 */
export async function warmMacosExec(binaryPath: string): Promise<void> {
  if (process.platform !== "darwin") return;

  await runQuietly("codesign", ["-f", "-s", "-", binaryPath]);
  await runQuietly(binaryPath, ["--version"]);
}

function runQuietly(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // A wedged security daemon can stall these calls indefinitely. Cap the wait:
    // an unwarmed binary is slower than we would like, never broken, so waiting
    // longer than the delay we are trying to avoid defeats the purpose.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 30_000);

    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", done);
    child.once("exit", done);
  });
}
