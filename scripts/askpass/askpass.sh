#!/bin/sh
# Aergic SSH askpass - Unix wrapper.
# Copyright (c) 2026 Aergic Labs, LLC
# SPDX-License-Identifier: AGPL-3.0-only
#
# Called by ssh when it needs a password/passphrase. Delegates to
# askpass-main.js which talks to the extension host via a Unix socket.

PROMPT="$1"
if [ -z "$PROMPT" ]; then
	read -r PROMPT
fi

if [ -z "$AERGIC_SSH_ASKPASS_HANDLE" ]; then
	echo "AERGIC_SSH_ASKPASS_HANDLE not set" >&2
	exit 1
fi

if [ -z "$AERGIC_SSH_ASKPASS_NODE" ]; then
	echo "AERGIC_SSH_ASKPASS_NODE not set" >&2
	exit 1
fi

if [ -z "$AERGIC_SSH_ASKPASS_MAIN" ]; then
	echo "AERGIC_SSH_ASKPASS_MAIN not set" >&2
	exit 1
fi

exec "$AERGIC_SSH_ASKPASS_NODE" "$AERGIC_SSH_ASKPASS_MAIN" "$PROMPT" "$AERGIC_SSH_ASKPASS_HANDLE"
