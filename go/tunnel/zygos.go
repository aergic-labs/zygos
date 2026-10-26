// Zygos-specific ops (op codes 100+). The ExecServer contract ops (1-99)
// live in main.go. These are the resolver's own server-lifecycle and
// resolve-lock operations; they are never exposed to other extensions.
package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	opServerStatus   = 100
	opServerCleanup  = 101
	opServerFinalize = 102
	opLock           = 103
	opUnlock         = 104
	opExtract        = 105
)

type serverArgs struct {
	InstallPath string `json:"installPath"`
}

type serverStatusResp struct {
	PID       int  `json:"pid,omitempty"`
	Port      int  `json:"port,omitempty"`
	Alive     bool `json:"alive"`
	ReusePort int  `json:"reusePort,omitempty"`
}

type serverCleanupResp struct {
	KilledPID int   `json:"killedPid,omitempty"`
	Strays    []int `json:"strays"`
}

type serverFinalizeArgs struct {
	InstallPath string `json:"installPath"`
	Port        int    `json:"port"`
	ReleaseLock bool   `json:"releaseLock"`
}

type serverFinalizeResp struct {
	PID int `json:"pid,omitempty"`
}

type lockArgs struct {
	Dir      string `json:"dir"`
	StaleSec int    `json:"staleSec"`
}

type lockResp struct {
	Acquired bool `json:"acquired"`
}

type unlockArgs struct {
	Dir string `json:"dir"`
}

func pidFilePath(installPath string) string  { return filepath.Join(installPath, ".server.pid") }
func portFilePath(installPath string) string { return filepath.Join(installPath, ".server.port") }
func lockDirPath(installPath string) string  { return filepath.Join(installPath, ".resolve-lock") }

// readPID reads a numeric pid from a file. Returns 0 if missing or invalid.
func readPID(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// signalPID sends a signal to a pid. Portable across platforms (Windows
// only supports Kill, but this compiles and the production target is
// Linux). Signal 0 is a liveness check.
func signalPID(pid int, sig syscall.Signal) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Signal(sig)
}

// pidAlive reports whether a pid is alive (signal 0).
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return signalPID(pid, 0) == nil
}

// portAlive dials 127.0.0.1:port with a short timeout.
func portAlive(port int) bool {
	if port <= 0 {
		return false
	}
	c, err := net.DialTimeout(
		"tcp",
		fmt.Sprintf("127.0.0.1:%d", port),
		500*time.Millisecond,
	)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// pidsMatching returns pids whose /proc/<pid>/cmdline contains the pattern.
func pidsMatching(pattern string) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []int
	self := os.Getpid()
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(string(b), pattern) {
			out = append(out, pid)
		}
	}
	return out
}

func doServerStatus(conn net.Conn, args []byte) {
	var a serverArgs
	if err := json.Unmarshal(args, &a); err != nil || a.InstallPath == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	pid := readPID(pidFilePath(a.InstallPath))
	port := readPID(portFilePath(a.InstallPath))
	alive := pidAlive(pid)
	resp := serverStatusResp{PID: pid, Port: port, Alive: alive}
	if alive && portAlive(port) {
		resp.ReusePort = port
	}
	writeJSON(conn, stOK, resp)
}

func doServerCleanup(conn net.Conn, args []byte) {
	var a serverArgs
	if err := json.Unmarshal(args, &a); err != nil || a.InstallPath == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	pid := readPID(pidFilePath(a.InstallPath))
	resp := serverCleanupResp{Strays: []int{}}
	if pid > 0 {
		resp.KilledPID = pid
		_ = signalPID(pid, syscall.SIGTERM)
		time.Sleep(time.Second)
		_ = signalPID(pid, syscall.SIGKILL)
	}
	for _, p := range pidsMatching(a.InstallPath) {
		if p == pid {
			continue
		}
		_ = signalPID(p, syscall.SIGKILL)
		resp.Strays = append(resp.Strays, p)
	}
	_ = os.Remove(pidFilePath(a.InstallPath))
	_ = os.Remove(portFilePath(a.InstallPath))
	writeJSON(conn, stOK, resp)
}

func doServerFinalize(conn net.Conn, args []byte) {
	var a serverFinalizeArgs
	if err := json.Unmarshal(args, &a); err != nil || a.InstallPath == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	// Find the server pid: match the server-main.js script first, then the
	// node binary under the install path.
	pid := 0
	if p := pidsMatching(filepath.Join(a.InstallPath, "out", "server-main.js")); len(p) > 0 {
		pid = p[0]
	} else if p := pidsMatching(filepath.Join(a.InstallPath, "node")); len(p) > 0 {
		pid = p[0]
	}
	if pid > 0 {
		_ = os.WriteFile(pidFilePath(a.InstallPath), []byte(strconv.Itoa(pid)), 0600)
		_ = os.WriteFile(portFilePath(a.InstallPath), []byte(strconv.Itoa(a.Port)), 0600)
	}
	if a.ReleaseLock {
		_ = os.RemoveAll(lockDirPath(a.InstallPath))
	}
	writeJSON(conn, stOK, serverFinalizeResp{PID: pid})
}

func doLock(conn net.Conn, args []byte) {
	var a lockArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Dir == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	acquired := false
	if err := os.Mkdir(a.Dir, 0755); err == nil {
		acquired = true
	} else if errors.Is(err, os.ErrExist) {
		// Stale? Reclaim if the dir is older than staleSec.
		if fi, statErr := os.Stat(a.Dir); statErr == nil {
			if time.Since(fi.ModTime()) > time.Duration(a.StaleSec)*time.Second {
				_ = os.RemoveAll(a.Dir)
				if err := os.Mkdir(a.Dir, 0755); err == nil {
					acquired = true
				}
			}
		}
	}
	writeJSON(conn, stOK, lockResp{Acquired: acquired})
}

func doUnlock(conn net.Conn, args []byte) {
	var a unlockArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Dir == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	_ = os.RemoveAll(a.Dir)
	_ = writeResp(conn, stOK, nil)
}

// extractArgs: stream a gzip-compressed tarball through the connection body
// and extract it to Dest with --strip-components=N. The body is read until
// EOF (half-close), same as opPut.
type extractArgs struct {
	Dest            string `json:"dest"`
	StripComponents int    `json:"stripComponents"`
}

// doExtract reads a gzip-compressed tarball from the connection body and
// extracts it to Dest. Strips the first StripComponents path components
// from each entry. Creates dirs, regular files, and symlinks; preserves
// modes. Hardlinks, devices, and other special types are skipped (the
// server tarball doesn't use them).
func doExtract(conn net.Conn, args []byte) {
	var a extractArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Dest == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	dest, err := resolveWrite(a.Dest)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	if err := os.MkdirAll(dest, 0755); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}

	gz, err := gzip.NewReader(conn)
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = writeResp(conn, stError, nil)
			return
		}

		// Strip the first N components. path.Clean normalizes "../" and
		// leading "/", then we count components.
		cleaned := path.Clean("/" + hdr.Name)
		parts := strings.Split(strings.TrimPrefix(cleaned, "/"), "/")
		if a.StripComponents > 0 && len(parts) > a.StripComponents {
			parts = parts[a.StripComponents:]
		}
		// Rebuild and reject any path that escapes the dest (contains ".."
		// after the strip).
		rel := filepath.Join(parts...)
		if rel == "." {
			continue
		}
		if strings.HasPrefix(rel, "..") {
			_ = writeResp(conn, stBadReq, nil)
			return
		}
		target := filepath.Join(dest, rel)

		mode := hdr.FileInfo().Mode()
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, mode); err != nil {
				_ = writeResp(conn, stError, nil)
				return
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				_ = writeResp(conn, stError, nil)
				return
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				_ = writeResp(conn, stError, nil)
				return
			}
			if _, err := io.Copy(f, tr); err != nil {
				_ = f.Close()
				_ = writeResp(conn, stError, nil)
				return
			}
			_ = f.Close()
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				_ = writeResp(conn, stError, nil)
				return
			}
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				_ = writeResp(conn, stError, nil)
				return
			}
		case tar.TypeLink, tar.TypeChar, tar.TypeBlock, tar.TypeFifo:
			// Skip: the server tarball doesn't use these.
			continue
		}
	}

	_ = writeResp(conn, stOK, nil)
}
