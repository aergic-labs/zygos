//go:build !linux

package main

import "errors"

// daemonize is a no-op on non-Linux platforms. The production target is
// Linux; this exists so the host build (tests) compiles.
func daemonize() error {
	return errors.New("--detach is only supported on linux")
}
