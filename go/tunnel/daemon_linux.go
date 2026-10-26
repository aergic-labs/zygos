//go:build linux

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// daemonize re-execs this binary detached (new session, no controlling
// terminal) and returns so the parent can exit. The child inherits the
// parent's stdout/stderr, so a shell redirect to a log file still works.
func daemonize() error {
	cmd := exec.Command(os.Args[0], os.Args[1:]...)
	cmd.Env = append(os.Environ(), "ZYGOS_DAEMON=1")
	cmd.Stdin = nil
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}
