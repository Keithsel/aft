import { spawn } from "node:child_process";

/**
 * Ad-hoc sign and warm a binary the test suite is about to spawn repeatedly.
 *
 * The first exec of a freshly written binary is expensive on macOS, and it is
 * NOT Gatekeeper assessment: setting com.apple.quarantine makes no difference,
 * and a plain read of the file buys the same speedup as re-signing. Measured on
 * this repo's 178 MB debug binary, relinking before each sample — cold 4.2s,
 * after `cat > /dev/null` 1.14s, after ad-hoc signing 1.1s (indistinguishable
 * from the read), second exec of the same inode 0.01s. Two layers: page-in,
 * which any full read clears, plus a per-inode first-exec cost that only an
 * actual exec clears. Both scale with binary size, and both inflate sharply
 * under memory pressure.
 *
 * cargo mints a new inode on every relink, and e2e tests spawn the binary under
 * short per-spawn timeouts, so that first exec reads as a hang and takes the
 * whole suite with it — this repo lost two full TS-suite runs to exactly that.
 *
 * The EXEC is the load-bearing step here; signing only helps because it reads
 * the file on the way past. Both are best-effort: this is a latency remedy, not
 * a correctness gate, so every failure path is swallowed and callers treat it
 * as advisory.
 *
 * SCOPE: this only pays off for a LARGE, freshly written binary. Small
 * executables (the shell shims some tests write) have nothing to page in and
 * gain nothing here.
 *
 * They are separately exposed to a rare spawn outlier. Across n=300 on a
 * two-line script: median 2.2ms, p99 3.4ms, and a single 260ms sample — so
 * roughly 0.3% incidence at ~100x the median, far outside the body but far too
 * rare to accumulate. Its cause is not established: it is not size-dependent,
 * not CPU contention (a deliberate-load run came out tighter than a quiet one),
 * and not an idle-wake ramp (spawns preceded by a 2s gap showed no tail).
 * Budget spawn-based tests for the observed magnitude rather than trying to
 * prevent it, and do not reach for this helper to fix a small-script flake.
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
