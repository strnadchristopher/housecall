//! Optional whole-object Linux Security 64 adapter. See docs/WHOLE-OBJECT-SCANNER.md.
use crate::Scanner;
use std::{
    io::{self, Read, Write},
    net::Shutdown,
    os::{
        fd::OwnedFd,
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const BUFFER: usize = 64 * 1024;
const OUTPUT_LIMIT: usize = 128 * 1024;
const ARGS: &[&str] = &[
    "--malware=none",
    "--pua=none",
    "--suspected=none",
    "--scan-archives=yes",
    "--max-nested=64",
    "--detect-max-nested=yes",
    "--detect-encrypted-archives=yes",
    "--detect-pua=yes",
    "--use-orsp=no",
    "--ignore-exclude-paths",
    "--quiet",
];

/// Explicit opt-in only: the licensed engine and its local service must already exist.
/// No original or derivative is released unless this adapter returns success.
pub struct WithSecureScanner {
    binary: PathBuf,
    timeout: Duration,
    slot: Mutex<()>,
}

impl WithSecureScanner {
    pub fn new(binary: PathBuf, timeout: Duration) -> io::Result<Self> {
        let executable = binary
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0);
        if !binary.is_absolute()
            || !executable
            || timeout.is_zero()
            || timeout > Duration::from_secs(86400)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "whole-object scanner requires an existing absolute executable and timeout <= 86400s",
            ));
        }
        Ok(Self {
            binary,
            timeout,
            slot: Mutex::new(()),
        })
    }
}

fn rejected() -> io::Error {
    io::Error::other("whole-object scan rejected, incomplete, or unavailable")
}

/// Observe completion without reaping: retain the leader's PID until group cleanup,
/// so an unrelated process group cannot reuse its numeric ID before Drop kills it.
fn exited_successfully(child: &Child) -> io::Result<Option<bool>> {
    // SAFETY: waitid writes an initialized siginfo_t; P_PID names our unreaped child.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: these access the SIGCHLD fields populated by waitid above.
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    Ok(Some(
        info.si_code == libc::CLD_EXITED && unsafe { info.si_status() } == 0,
    ))
}

/// Always kill the command's private process group and reap the immediate child.
/// This also handles failures during I/O setup and unwinding.
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: CommandExt::process_group(0) assigned this child its own group;
        // a negative PID targets that group, never the application's group.
        unsafe {
            libc::kill(-(self.0.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn drain(stream: &mut UnixStream, total: &mut usize) -> io::Result<(bool, bool)> {
    let mut bytes = [0; 8192];
    match stream.read(&mut bytes) {
        Ok(0) => Ok((true, false)),
        Ok(n) => {
            *total += n;
            if *total > OUTPUT_LIMIT {
                return Err(rejected());
            }
            // Never retain scanner output: it can contain private source content.
            Ok((false, true))
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok((false, false)),
        Err(e) if e.kind() == io::ErrorKind::Interrupted => Ok((false, true)),
        Err(_) => Err(rejected()),
    }
}

impl Scanner for WithSecureScanner {
    fn engine(&self) -> crate::scan::Engine {
        crate::scan::Engine::Withsecure
    }
    fn scan(&self, source: &mut dyn Read) -> io::Result<()> {
        // Reject overload instead of accumulating waiting requests/threads.
        let _slot = self.slot.try_lock().map_err(|_| rejected())?;
        let deadline = Instant::now() + self.timeout;
        let (mut input, child_input) = UnixStream::pair()?;
        // Retain the receiving endpoint to prove the child consumed every byte,
        // including short sources that fit entirely in the kernel socket buffer.
        let mut unread_check = child_input.try_clone()?;
        let (mut output, child_output) = UnixStream::pair()?;
        let (mut errors, child_errors) = UnixStream::pair()?;
        input.set_nonblocking(true)?;
        output.set_nonblocking(true)?;
        errors.set_nonblocking(true)?;
        let mut cmd = Command::new(&self.binary);
        cmd.args(ARGS)
            .env_clear()
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .current_dir("/")
            .process_group(0)
            .stdin(Stdio::from(OwnedFd::from(child_input)))
            .stdout(Stdio::from(OwnedFd::from(child_output)))
            .stderr(Stdio::from(OwnedFd::from(child_errors)));
        // SAFETY: only async-signal-safe libc calls with stack-owned constants
        // occur between fork and exec; no locks or allocation are used.
        unsafe {
            cmd.pre_exec(|| {
                for (resource, limit) in [
                    (libc::RLIMIT_CORE, 0),
                    (libc::RLIMIT_NOFILE, 64),
                    (libc::RLIMIT_AS, 1024 * 1024 * 1024),
                ] {
                    let value = libc::rlimit {
                        rlim_cur: limit,
                        rlim_max: limit,
                    };
                    if libc::setrlimit(resource, &value) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let process = Process(cmd.spawn()?);
        // Command owns the parent's copies of the child endpoints until dropped.
        drop(cmd);
        let mut bytes = [0; BUFFER];
        let (mut start, mut end) = (0, 0);
        let mut eof = false;
        let mut output_total = 0;
        let mut status = None;
        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "whole-object scan timed out",
                ));
            }
            let (out_eof, out_progress) = drain(&mut output, &mut output_total)?;
            let (err_eof, err_progress) = drain(&mut errors, &mut output_total)?;
            let mut progress = out_progress || err_progress;
            if status.is_none() {
                status = exited_successfully(&process.0)?;
            }
            if let Some(status) = status {
                if !status || !eof || start != end {
                    return Err(rejected());
                }
                // EOF on the retained input endpoint proves no queued bytes were
                // left unread. A clean exit alone cannot prove this.
                unread_check.set_nonblocking(true)?;
                if unread_check.read(&mut [0]).map_err(|_| rejected())? != 0 {
                    return Err(rejected());
                }
                if out_eof && err_eof {
                    return Ok(());
                }
            } else if !eof {
                if start == end {
                    match source.read(&mut bytes) {
                        Ok(0) => {
                            eof = true;
                            input.shutdown(Shutdown::Write)?;
                        }
                        Ok(n) => {
                            start = 0;
                            end = n;
                        }
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => return Err(rejected()),
                    }
                    progress = true;
                }
                if start < end {
                    match input.write(&bytes[start..end]) {
                        Ok(0) => return Err(rejected()),
                        Ok(n) => {
                            start += n;
                            progress = true;
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => return Err(rejected()),
                    }
                }
            }
            if !progress {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}
