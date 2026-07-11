#!/bin/sh
# Zygos SSH askpass - Unix wrapper.
# Copyright (c) 2026 Aergic Labs, LLC
# SPDX-License-Identifier: AGPL-3.0-only
#
# Called by ssh when it needs a password/passphrase. Delegates to
# askpass-main.js which talks to the extension host via a Unix socket.

PROMPT="$1"
if [ -z "$PROMPT" ]; then
	read -r PROMPT
fi

if [ -z "$ZYGOS_SSH_ASKPASS_HANDLE" ]; then
	echo "ZYGOS_SSH_ASKPASS_HANDLE not set" >&2
	exit 1
fi

if [ -z "$ZYGOS_SSH_ASKPASS_NODE" ]; then
	echo "ZYGOS_SSH_ASKPASS_NODE not set" >&2
	exit 1
fi

if [ -z "$ZYGOS_SSH_ASKPASS_MAIN" ]; then
	echo "ZYGOS_SSH_ASKPASS_MAIN not set" >&2
	exit 1
fi

exec "$ZYGOS_SSH_ASKPASS_NODE" "$ZYGOS_SSH_ASKPASS_MAIN" "$PROMPT" "$ZYGOS_SSH_ASKPASS_HANDLE"
