// Command tunnel is the zygos remote transport: a small static Go server
// that replaces the ssh session control shell and the HTTP tunnel. It
// listens on a loopback port and speaks a minimal per-op protocol over
// raw TCP, reached through the client's SOCKS forward.
//
// Protocol, one op per connection:
//
//	request:  [token:32][op:u8][flags:u8][argLen:u32][args]
//	response: [status:u8][argLen:u32][args]
//
// args is JSON for the small ops. For the streaming ops the body follows
// the header:
//
//   - PUT / GET: raw body, EOF-delimited via half-close.
//   - SPAWN:     raw stdin one way; framed [stream:u8][len:u32][data]
//     chunks the other way, terminated by an exit frame.
//
// Every op is client-initiated. The server never sends a request frame.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// --- ops ---

const (
	opExec     = 1
	opSpawn    = 2
	opPut      = 3
	opGet      = 4
	opStat     = 5
	opReaddir  = 6
	opMkdir    = 7
	opRename   = 8
	opRm       = 9
	opEnv      = 10
	opKill     = 11
	opHealth   = 12
	opConnect  = 13
	opWaitFile = 14
)

// --- response status ---

const (
	stOK      = 0
	stError   = 1
	stMissing = 2
	stBadReq  = 3
	stDenied  = 4
)

// --- spawn stream tags ---

const (
	streamStdout = 0
	streamStderr = 1
	streamExit   = 2
)

// tokenLen is the raw bearer length on the wire. The token file holds it
// hex-encoded (2*tokenLen chars).
const tokenLen = 32

var (
	port     = flag.Int("port", 0, "listen port (0 = pick free)")
	metaFile = flag.String("meta-file", "", "write port/pid/token JSON here (atomic)")
	idleMs   = flag.Int("idle-timeout-ms", 120000, "exit after this many ms idle")
	root     = flag.String("root", "", "read root (default $HOME)")
	detach   = flag.Bool("detach", false, "self-daemonize (new session, no controlling terminal)")
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

var writeRoots stringList

var (
	bearer   []byte
	rootAbs  string
	writeAbs []string
	lastAct  time.Time
	actMu    sync.Mutex
)

func main() {
	flag.Var(&writeRoots, "write-root", "write root (repeatable)")
	flag.Parse()

	// Self-daemonize: re-exec detached and let the parent exit. The child
	// carries ZYGOS_DAEMON so it doesn't recurse.
	if *detach && os.Getenv("ZYGOS_DAEMON") == "" {
		if err := daemonize(); err != nil {
			fatal("daemonize: %v", err)
		}
		os.Exit(0)
	}

	// Self-generate the bearer token from crypto/rand. The resolver reads
	// it from the meta file (writeMetaFile serializes it as hex). Avoids a
	// pre-listener window where a token file would sit on disk with no
	// listener, and removes one putFile round-trip from cold start.
	bearer = make([]byte, tokenLen)
	var err error
	if _, err = rand.Read(bearer); err != nil {
		fatal("rand: %v", err)
	}

	if *root == "" {
		home, _ := os.UserHomeDir()
		*root = home
	}
	rootAbs, err = filepath.Abs(*root)
	if err != nil {
		fatal("resolve root: %v", err)
	}
	for _, wr := range writeRoots {
		a, err := filepath.Abs(wr)
		if err != nil {
			fatal("resolve write-root: %v", err)
		}
		writeAbs = append(writeAbs, a)
	}
	// No explicit write roots: writes are allowed under the read root.
	if len(writeAbs) == 0 {
		writeAbs = []string{rootAbs}
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fatal("listen: %v", err)
	}
	actual := ln.Addr().(*net.TCPAddr).Port
	if *metaFile != "" {
		writeMetaFile(*metaFile, actual, os.Getpid(), bearer)
	}

	lastAct = time.Now()
	go idleWatch()

	logf("listening on 127.0.0.1:%d (root=%s)", actual, rootAbs)
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleConn(conn)
	}
}

func handleConn(conn net.Conn) {
	defer conn.Close()
	touch()

	tok := make([]byte, tokenLen)
	if _, err := io.ReadFull(conn, tok); err != nil {
		return
	}
	if subtle.ConstantTimeCompare(tok, bearer) != 1 {
		return
	}

	hdr := make([]byte, 6)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return
	}
	op := hdr[0]
	argLen := binary.BigEndian.Uint32(hdr[2:6])
	args := make([]byte, argLen)
	if _, err := io.ReadFull(conn, args); err != nil {
		return
	}

	switch op {
	case opExec:
		doExec(conn, args)
	case opSpawn:
		doSpawn(conn, args)
	case opPut:
		doPut(conn, args)
	case opGet:
		doGet(conn, args)
	case opStat:
		doStat(conn, args)
	case opReaddir:
		doReaddir(conn, args)
	case opMkdir:
		doMkdir(conn, args)
	case opRename:
		doRename(conn, args)
	case opRm:
		doRm(conn, args)
	case opEnv:
		doEnv(conn, args)
	case opKill:
		doKill(conn, args)
	case opHealth:
		_ = writeResp(conn, stOK, nil)
	case opConnect:
		doConnect(conn, args)
	case opWaitFile:
		doWaitFile(conn, args)

	// --- zygos ops (100+) ---
	case opServerStatus:
		doServerStatus(conn, args)
	case opServerCleanup:
		doServerCleanup(conn, args)
	case opServerFinalize:
		doServerFinalize(conn, args)
	case opLock:
		doLock(conn, args)
	case opUnlock:
		doUnlock(conn, args)
	case opExtract:
		doExtract(conn, args)

	default:
		_ = writeResp(conn, stBadReq, nil)
	}
}

// --- framing ---

func writeResp(w io.Writer, status byte, args []byte) error {
	hdr := make([]byte, 5)
	hdr[0] = status
	binary.BigEndian.PutUint32(hdr[1:5], uint32(len(args)))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(args) > 0 {
		_, err := w.Write(args)
		return err
	}
	return nil
}

func writeJSON(w io.Writer, status byte, v any) {
	b, _ := json.Marshal(v)
	_ = writeResp(w, status, b)
}

// --- path scoping ---

func resolveRead(p string) (string, error) { return resolveUnder(rootAbs, p) }

func resolveWrite(p string) (string, error) {
	for _, wr := range writeAbs {
		if abs, err := resolveUnder(wr, p); err == nil {
			return abs, nil
		}
	}
	return "", errors.New("path outside write roots")
}

func resolveUnder(base, p string) (string, error) {
	if p == "" {
		return "", errors.New("missing path")
	}
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(base, abs)
	}
	cleaned := filepath.Clean(abs)
	rel, err := filepath.Rel(base, cleaned)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes root")
	}
	return cleaned, nil
}

// --- ops ---

type execArgs struct {
	Cmd  string            `json:"cmd"`
	Args []string          `json:"args"`
	Cwd  string            `json:"cwd"`
	Env  map[string]string `json:"env"`
}

type execResp struct {
	Stdout   string `json:"stdout"` // base64
	Stderr   string `json:"stderr"` // base64
	ExitCode int    `json:"exitCode"`
}

func doExec(conn net.Conn, args []byte) {
	var a execArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	cmd := exec.Command(a.Cmd, a.Args...)
	cmd.Dir = a.Cwd
	if a.Env != nil {
		cmd.Env = envSlice(a.Env)
	}
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	code := exitCode(cmd.Run())
	writeJSON(conn, stOK, execResp{
		Stdout:   base64.StdEncoding.EncodeToString([]byte(out.String())),
		Stderr:   base64.StdEncoding.EncodeToString([]byte(errb.String())),
		ExitCode: code,
	})
}

func doSpawn(conn net.Conn, args []byte) {
	var a execArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	cmd := exec.Command(a.Cmd, a.Args...)
	cmd.Dir = a.Cwd
	if a.Env != nil {
		cmd.Env = envSlice(a.Env)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	if err := cmd.Start(); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	if err := writeResp(conn, stOK, nil); err != nil {
		_ = cmd.Process.Kill()
		return
	}

	var wmu sync.Mutex
	frame := func(tag byte, data []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		h := make([]byte, 5)
		h[0] = tag
		binary.BigEndian.PutUint32(h[1:5], uint32(len(data)))
		_, _ = conn.Write(h)
		_, _ = conn.Write(data)
	}

	// stdin: connection -> process, until the client half-closes.
	go func() {
		_, _ = io.Copy(stdin, conn)
		_ = stdin.Close()
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	pump := func(r io.Reader, tag byte) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				frame(tag, buf[:n])
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout, streamStdout)
	go pump(stderr, streamStderr)
	wg.Wait()

	code := exitCode(cmd.Wait())
	ec := make([]byte, 4)
	binary.BigEndian.PutUint32(ec, uint32(code))
	frame(streamExit, ec)
}

type putArgs struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
}

func doPut(conn net.Conn, args []byte) {
	var a putArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveWrite(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	mode := parseMode(a.Mode)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_, err = io.Copy(f, conn)
	_ = f.Close()
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_ = os.Chmod(p, mode)
	_ = writeResp(conn, stOK, nil)
}

type pathArgs struct {
	Path string `json:"path"`
}

func doGet(conn net.Conn, args []byte) {
	var a pathArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveRead(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			_ = writeResp(conn, stMissing, nil)
			return
		}
		_ = writeResp(conn, stError, nil)
		return
	}
	defer f.Close()
	if err := writeResp(conn, stOK, nil); err != nil {
		return
	}
	_, _ = io.Copy(conn, f)
}

type statResp struct {
	Type  int   `json:"type"`
	Ctime int64 `json:"ctime"`
	Mtime int64 `json:"mtime"`
	Size  int64 `json:"size"`
}

func doStat(conn net.Conn, args []byte) {
	var a pathArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveRead(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	fi, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			_ = writeResp(conn, stMissing, nil)
			return
		}
		_ = writeResp(conn, stError, nil)
		return
	}
	writeJSON(conn, stOK, statResp{
		Type:  fileType(fi.Mode()),
		Ctime: fi.ModTime().UnixMilli(),
		Mtime: fi.ModTime().UnixMilli(),
		Size:  fi.Size(),
	})
}

type dirEntry struct {
	Type int    `json:"type"`
	Name string `json:"name"`
}

func doReaddir(conn net.Conn, args []byte) {
	var a pathArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveRead(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	out := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		t := 1
		if e.IsDir() {
			t = 2
		}
		out = append(out, dirEntry{Type: t, Name: e.Name()})
	}
	writeJSON(conn, stOK, out)
}

func doMkdir(conn net.Conn, args []byte) {
	var a pathArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveWrite(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	if err := os.MkdirAll(p, 0755); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_ = writeResp(conn, stOK, nil)
}

type renameArgs struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func doRename(conn net.Conn, args []byte) {
	var a renameArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	from, err := resolveWrite(a.From)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	to, err := resolveWrite(a.To)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	if err := os.Rename(from, to); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_ = writeResp(conn, stOK, nil)
}

func doRm(conn net.Conn, args []byte) {
	var a pathArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveWrite(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	if err := os.RemoveAll(p); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_ = writeResp(conn, stOK, nil)
}

type envResp struct {
	OSPlatform string            `json:"osPlatform"`
	OSRelease  string            `json:"osRelease"`
	Env        map[string]string `json:"env"`
}

func doEnv(conn net.Conn, _ []byte) {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	writeJSON(conn, stOK, envResp{
		OSPlatform: runtime.GOOS,
		OSRelease:  unameRelease(),
		Env:        env,
	})
}

type killArgs struct {
	PID int `json:"pid"`
}

func doKill(conn net.Conn, args []byte) {
	var a killArgs
	if err := json.Unmarshal(args, &a); err != nil || a.PID <= 0 {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	proc, err := os.FindProcess(a.PID)
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	_ = writeResp(conn, stOK, nil)
}

type connectArgs struct {
	Path string `json:"path"`
}

func doConnect(conn net.Conn, args []byte) {
	var a connectArgs
	if err := json.Unmarshal(args, &a); err != nil {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	uc, err := net.Dial("unix", a.Path)
	if err != nil {
		_ = writeResp(conn, stError, nil)
		return
	}
	defer uc.Close()
	if err := writeResp(conn, stOK, nil); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(uc, conn); done <- struct{}{} }()
	go func() { _, _ = io.Copy(conn, uc); done <- struct{}{} }()
	<-done
}

// metaFileJSON is the atomic single-file record the resolver reads to
// discover the transport's port, pid, and bearer token. Replaces the prior
// tunnel-port + tunnel-pid + tunnel-token triple. Written once at startup;
// the resolver reads it via a single `cat` (control shell) or waitForFile op.
type metaFileJSON struct {
	Port  int    `json:"port"`
	PID   int    `json:"pid"`
	Token string `json:"token"` // hex-encoded bearer
}

// writeMetaFile writes the port/pid/token JSON atomically (temp + rename) so
// a reader never sees a partial file. Mode 0600: the token is a secret.
func writeMetaFile(path string, port, pid int, bearer []byte) {
	b, _ := json.Marshal(metaFileJSON{
		Port:  port,
		PID:   pid,
		Token: hex.EncodeToString(bearer),
	})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// waitFileArgs: block until `path` exists and is non-empty, or `timeoutMs`
// elapses. The server polls the file locally (no round-trip over the wire),
// returning the file content on success or stMissing on timeout. Used by the
// resolver to wait for the REH server's ready-file without a poll loop of
// `cat` round-trips.
type waitFileArgs struct {
	Path      string `json:"path"`
	TimeoutMs int    `json:"timeoutMs"`
}

// maxWaitFileMs caps how long the server will hold a connection open for a
// single waitForFile call. The resolver passes its own deadline (60s for the
// server ready-file); this is a safety ceiling so a buggy client can't pin
// a goroutine forever.
const maxWaitFileMs = 120_000

func doWaitFile(conn net.Conn, args []byte) {
	var a waitFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Path == "" {
		_ = writeResp(conn, stBadReq, nil)
		return
	}
	p, err := resolveRead(a.Path)
	if err != nil {
		_ = writeResp(conn, stDenied, nil)
		return
	}
	timeout := time.Duration(a.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > maxWaitFileMs*time.Millisecond {
		timeout = maxWaitFileMs * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	for {
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			_ = writeResp(conn, stOK, b)
			return
		}
		if time.Now().After(deadline) {
			_ = writeResp(conn, stMissing, nil)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// --- helpers ---

func envSlice(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			return ws.ExitStatus()
		}
		return 1
	}
	return 1
}

func fileType(m os.FileMode) int {
	switch {
	case m.IsDir():
		return 2 // FileType.Directory
	case m&os.ModeSymlink != 0:
		return 64 // FileType.SymbolicLink
	case m.IsRegular():
		return 1 // FileType.File
	default:
		return 0
	}
}

func parseMode(s string) os.FileMode {
	if s == "" {
		return 0600
	}
	var m uint32
	if _, err := fmt.Sscanf(s, "%o", &m); err != nil || m == 0 {
		return 0600
	}
	return os.FileMode(m)
}

func unameRelease() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func touch() {
	actMu.Lock()
	lastAct = time.Now()
	actMu.Unlock()
}

func idleWatch() {
	for {
		time.Sleep(time.Second)
		actMu.Lock()
		since := time.Since(lastAct)
		actMu.Unlock()
		if since > time.Duration(*idleMs)*time.Millisecond {
			logf("idle timeout, exiting")
			os.Exit(0)
		}
	}
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[tunnel] "+format+"\n", a...)
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[tunnel] "+format+"\n", a...)
	os.Exit(1)
}
