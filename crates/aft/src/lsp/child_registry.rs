//! Process-wide registry of LSP child PIDs spawned by `LspClient::spawn`.
//!
//! Mirrors the `BgTaskRegistry` pattern: `Arc`-cloneable handle that the
//! signal handler thread can use to SIGKILL all child language servers
//! before the aft process exits. Without this registry, LSP children get
//! orphaned to PID 1 when aft is SIGTERM'd by its parent (e.g., during
//! plugin bridge.shutdown() or e2e test cleanup), accumulating across runs.
//!
//! The registry intentionally does NOT do graceful shutdown — that takes
//! up to 5 seconds per server (shutdown request + exit notification +
//! poll). Signal handlers must finish quickly. Graceful shutdown still
//! happens on the natural stdin-closed exit path via `LspManager::shutdown_all`.

use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LspChildHealth {
    pub spawned: usize,
    pub cwd_gone: usize,
}

#[derive(Clone, Default)]
pub struct LspChildRegistry {
    inner: Arc<Mutex<HashSet<u32>>>,
}

impl LspChildRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Track a newly-spawned LSP child PID.
    pub fn track(&self, pid: u32) {
        if let Ok(mut set) = self.inner.lock() {
            set.insert(pid);
        }
    }

    /// Spawn a child while holding the same mutex used by signal cleanup, then
    /// insert its PID before releasing that mutex. This closes the SIGINT /
    /// SIGTERM spawn→track race: if cleanup starts concurrently, it blocks
    /// until the just-spawned child is present in the tracked set.
    pub fn spawn_tracked(&self, command: &mut Command) -> io::Result<Child> {
        let mut set = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("LSP child registry mutex poisoned"))?;
        let child = command.spawn()?;
        set.insert(child.id());
        Ok(child)
    }

    /// Forget a PID (called when the client is dropped or shut down gracefully).
    pub fn untrack(&self, pid: u32) {
        if let Ok(mut set) = self.inner.lock() {
            set.remove(&pid);
        }
    }

    /// Snapshot of currently-tracked PIDs.
    pub fn pids(&self) -> Vec<u32> {
        self.inner
            .lock()
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Snapshot the current child count and the children whose working directory
    /// no longer resolves. CWD lookup uses the kernel process API rather than a
    /// subprocess so this remains cheap enough for health and maintenance paths.
    pub fn health_snapshot(&self) -> LspChildHealth {
        health_for_pids(self.pids())
    }

    /// Non-blocking health snapshot for latency-sensitive probes.
    pub fn try_health_snapshot(&self) -> Option<LspChildHealth> {
        let pids = self
            .inner
            .try_lock()
            .ok()?
            .iter()
            .copied()
            .collect::<Vec<_>>();
        Some(health_for_pids(pids))
    }

    /// Kill and untrack every child whose working directory no longer exists.
    /// This is a crash/leak backstop; ordinary root teardown still drops the
    /// owning `LspClient` and performs its normal process-group cleanup.
    pub fn reap_children_with_gone_cwd(&self) -> usize {
        let mut reaped = 0;
        for pid in self.pids() {
            if !matches!(child_cwd_state(pid), ChildCwdState::Gone) {
                continue;
            }
            if kill_child_process_group(pid) {
                self.untrack(pid);
                reaped += 1;
            }
        }
        reaped
    }

    /// Force-kill every tracked child synchronously. Used by the signal
    /// handler to prevent orphaned LSP processes when aft is SIGTERM'd.
    /// Returns the number of process groups that were sent SIGKILL.
    ///
    /// On Unix, kills the entire process group (via `killpg`) rather than
    /// just the wrapper PID. Necessary because npm-wrapped LSP servers like
    /// biome ship as `node biome lsp-proxy` shims that spawn the real
    /// `cli-darwin-arm64 biome lsp-proxy` as a child; killing only the
    /// wrapper leaves the real server orphaned to PID 1.
    ///
    /// `LspClient::spawn` puts each child in its own session via `setsid()`
    /// so `pgid == child.id()`.
    #[cfg(unix)]
    pub fn kill_all(&self) -> usize {
        use std::os::raw::c_int;
        let pids = self.pids();
        let mut killed = 0;
        for pid in pids {
            // SIGKILL = 9. We use the raw libc call rather than crossbeam
            // because we're inside a signal-handler context where allocator
            // and channel use is risky.
            // SAFETY: killpg(2) is async-signal-safe.
            unsafe {
                let pgid = pid as libc::pid_t;
                let rc = libc::killpg(pgid, 9 as c_int);
                if rc == 0 {
                    killed += 1;
                }
            }
        }
        killed
    }

    /// Windows fallback: best-effort kill via `taskkill /F /T`. The `/T`
    /// flag kills the entire process tree (Windows analogue of process
    /// groups). Not technically async-signal-safe but Windows doesn't
    /// deliver signals the same way.
    #[cfg(not(unix))]
    pub fn kill_all(&self) -> usize {
        let pids = self.pids();
        let mut killed = 0;
        for pid in pids {
            if std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .status()
                .is_ok()
            {
                killed += 1;
            }
        }
        killed
    }
}

fn health_for_pids(pids: Vec<u32>) -> LspChildHealth {
    let cwd_gone = pids
        .iter()
        .filter(|pid| matches!(child_cwd_state(**pid), ChildCwdState::Gone))
        .count();
    LspChildHealth {
        spawned: pids.len(),
        cwd_gone,
    }
}

#[derive(Debug)]
enum ChildCwdState {
    Present,
    Gone,
    Unknown,
}

fn child_cwd_state(pid: u32) -> ChildCwdState {
    let Ok(cwd) = child_cwd(pid) else {
        return ChildCwdState::Unknown;
    };
    match cwd.try_exists() {
        Ok(true) => ChildCwdState::Present,
        Ok(false) => ChildCwdState::Gone,
        Err(_) => ChildCwdState::Unknown,
    }
}

#[cfg(target_os = "linux")]
fn child_cwd(pid: u32) -> io::Result<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
}

#[cfg(target_os = "macos")]
fn child_cwd(pid: u32) -> io::Result<PathBuf> {
    use std::ffi::CStr;
    use std::mem::{size_of, zeroed};
    use std::os::unix::ffi::OsStrExt;

    const PROC_PIDVNODEPATHINFO: libc::c_int = 9;

    #[repr(C)]
    struct VInfoStat {
        dev: u32,
        mode: u16,
        nlink: u16,
        ino: u64,
        uid: u32,
        gid: u32,
        atime: i64,
        atime_nsec: i64,
        mtime: i64,
        mtime_nsec: i64,
        ctime: i64,
        ctime_nsec: i64,
        birthtime: i64,
        birthtime_nsec: i64,
        size: i64,
        blocks: i64,
        block_size: i32,
        flags: u32,
        generation: u32,
        raw_device: u32,
        spare: [i64; 2],
    }

    #[repr(C)]
    struct VnodeInfo {
        stat: VInfoStat,
        vnode_type: i32,
        pad: i32,
        fsid: [i32; 2],
    }

    #[repr(C)]
    struct VnodeInfoPath {
        info: VnodeInfo,
        path: [libc::c_char; libc::MAXPATHLEN as usize],
    }

    #[repr(C)]
    struct ProcVnodePathInfo {
        cwd: VnodeInfoPath,
        root: VnodeInfoPath,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            buffer_size: libc::c_int,
        ) -> libc::c_int;
    }

    let pid = libc::c_int::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "PID exceeds c_int"))?;
    // SAFETY: the value is plain C data and proc_pidinfo receives its exact size.
    let mut info: ProcVnodePathInfo = unsafe { zeroed() };
    let buffer_size = libc::c_int::try_from(size_of::<ProcVnodePathInfo>())
        .map_err(|_| io::Error::other("proc vnode path buffer is too large"))?;
    // SAFETY: `info` is valid writable storage for `buffer_size` bytes, and the
    // libproc call does not retain the pointer after returning.
    let bytes = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut ProcVnodePathInfo).cast(),
            buffer_size,
        )
    };
    if bytes <= 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel writes a NUL-terminated MAXPATHLEN path into this field.
    let cwd = unsafe { CStr::from_ptr(info.cwd.path.as_ptr()) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(cwd.to_bytes())))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn child_cwd(_pid: u32) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "child cwd lookup is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn kill_child_process_group(pid: u32) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // LspClient creates a session per child, so the child PID is also its PGID.
    // SAFETY: killpg does not dereference pointers and SIGKILL needs no handler.
    let result = unsafe { libc::killpg(pgid, libc::SIGKILL) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn kill_child_process_group(pid: u32) -> bool {
    std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_untrack_pids_round_trip() {
        let reg = LspChildRegistry::new();
        reg.track(100);
        reg.track(200);
        let mut pids = reg.pids();
        pids.sort();
        assert_eq!(pids, vec![100, 200]);
        reg.untrack(100);
        assert_eq!(reg.pids(), vec![200]);
    }

    #[test]
    fn clones_share_state() {
        let a = LspChildRegistry::new();
        let b = a.clone();
        a.track(42);
        assert_eq!(b.pids(), vec![42]);
        b.untrack(42);
        assert!(a.pids().is_empty());
    }

    #[test]
    fn untracking_unknown_pid_is_safe() {
        let reg = LspChildRegistry::new();
        reg.untrack(999); // no-op, no panic
        assert!(reg.pids().is_empty());
    }

    #[test]
    fn health_snapshot_counts_spawned_child_with_live_cwd() {
        let reg = LspChildRegistry::new();
        reg.track(std::process::id());
        assert_eq!(
            reg.health_snapshot(),
            LspChildHealth {
                spawned: 1,
                cwd_gone: 0,
            }
        );
        reg.untrack(std::process::id());
    }

    #[test]
    fn kill_all_with_no_pids_returns_zero() {
        let reg = LspChildRegistry::new();
        assert_eq!(reg.kill_all(), 0);
    }

    #[test]
    fn spawn_tracked_records_pid_before_returning() {
        let reg = LspChildRegistry::new();
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        } else {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };

        let mut child = reg.spawn_tracked(&mut command).expect("spawn tracked");
        let pid = child.id();
        assert!(reg.pids().contains(&pid));
        let _ = child.wait();
        reg.untrack(pid);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn maintenance_reaps_child_whose_cwd_was_deleted() {
        use std::os::unix::process::CommandExt;

        let root = tempfile::tempdir().expect("tempdir");
        let reg = LspChildRegistry::new();
        let mut command = Command::new("sh");
        command
            .args(["-c", "exec sleep 60"])
            .current_dir(root.path());
        // Match LspClient: each child leads its own process group, allowing the
        // maintenance backstop to kill wrappers and descendants together.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = reg.spawn_tracked(&mut command).expect("spawn child");
        root.close().expect("delete child cwd");

        assert_eq!(
            reg.health_snapshot(),
            LspChildHealth {
                spawned: 1,
                cwd_gone: 1,
            }
        );
        assert_eq!(reg.reap_children_with_gone_cwd(), 1);
        child.wait().expect("reap child");
        assert_eq!(reg.health_snapshot(), LspChildHealth::default());
    }

    // Regression for the npm-wrapper orphan bug: biome ships as `node
    // biome lsp-proxy` (the wrapper) that spawns
    // `cli-darwin-arm64 biome lsp-proxy` (the actual server) as a child.
    // Killing just the wrapper PID via `kill(2)` leaves the real server
    // orphaned to PID 1. `killpg(2)` kills the whole group.
    //
    // This test simulates that two-process structure with a shell pipeline:
    // a parent shell that forks a child `sleep`. The parent stays attached
    // (via wait), so both die when the group is killed.
    #[cfg(unix)]
    #[test]
    fn kill_all_kills_process_group_not_just_wrapper_pid() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        use std::thread;
        use std::time::{Duration, Instant};

        /// Running process (excludes zombies: kill(0) still succeeds on zombies).
        fn process_running(pid: u32) -> bool {
            let Ok(pid_i) = i32::try_from(pid) else {
                return false;
            };
            let output = Command::new("ps")
                .args(["-o", "stat=", "-p", &pid_i.to_string()])
                .output()
                .expect("ps");
            if !output.status.success() {
                return false;
            }
            let stat = String::from_utf8_lossy(&output.stdout);
            !stat.is_empty() && !stat.contains('Z')
        }

        fn wait_until_not_running(pid: u32, timeout: Duration) -> bool {
            let started = Instant::now();
            while started.elapsed() < timeout {
                if !process_running(pid) {
                    return true;
                }
                thread::sleep(Duration::from_millis(50));
            }
            false
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("grandchild.pid");
        // Pass the path via env so the shell never interpolates TMPDIR characters
        // (e.g. embedded single quotes) into the script literal.
        const PID_FILE_ENV: &str = "AFT_LSP_KILLALL_TEST_PID_FILE";

        let mut child = unsafe {
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg("sleep 60 & echo $! > \"$AFT_LSP_KILLALL_TEST_PID_FILE\"; wait")
                .env(PID_FILE_ENV, &pid_file);
            // setsid() so wrapper becomes its own process-group leader,
            // matching what LspClient::spawn does.
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
            cmd.spawn().expect("spawn wrapper")
        };

        let wrapper_pid = child.id();
        let started = Instant::now();
        // Wait for parseable CONTENT, not mere existence: the shell's `>`
        // redirect creates the file before `echo` writes into it, so an
        // existence check can win the race against an empty file and fail the
        // parse. Under a loaded machine that window is wide enough to hit.
        let grandchild_pid: u32 = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|contents| contents.trim().parse::<u32>().ok())
            {
                break pid;
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "timed out waiting for a parseable grandchild pid file"
            );
            thread::sleep(Duration::from_millis(20));
        };

        assert!(process_running(wrapper_pid), "wrapper should be running");
        assert!(
            process_running(grandchild_pid),
            "grandchild should be running"
        );

        let reg = LspChildRegistry::new();
        reg.track(wrapper_pid);
        let killed = reg.kill_all();
        assert_eq!(killed, 1, "should report 1 group killed");

        let _ = child.wait();

        assert!(
            wait_until_not_running(wrapper_pid, Duration::from_secs(5)),
            "wrapper must stop after killpg"
        );
        // without killpg() the grandchild would survive as an orphan.
        assert!(
            wait_until_not_running(grandchild_pid, Duration::from_secs(5)),
            "grandchild must stop after killpg (this was the npm-wrapper orphan bug)"
        );
    }
}
