@echo off
REM Zygos SSH askpass - Windows wrapper.
REM Copyright (c) 2026 Aergic Labs, LLC
REM SPDX-License-Identifier: AGPL-3.0-only
REM
REM Called by ssh when it needs a password/passphrase. Delegates to
REM askpass-main.js which talks to the extension host via a named pipe.

set "PROMPT=%~1"

if not defined PROMPT (
    echo ERROR: No prompt provided 1>&2
    exit /b 1
)

if not defined ZYGOS_SSH_ASKPASS_HANDLE (
    echo ERROR: ZYGOS_SSH_ASKPASS_HANDLE not set 1>&2
    exit /b 1
)

if not defined ZYGOS_SSH_ASKPASS_NODE (
    echo ERROR: ZYGOS_SSH_ASKPASS_NODE not set 1>&2
    exit /b 1
)

if not defined ZYGOS_SSH_ASKPASS_MAIN (
    echo ERROR: ZYGOS_SSH_ASKPASS_MAIN not set 1>&2
    exit /b 1
)

"%ZYGOS_SSH_ASKPASS_NODE%" "%ZYGOS_SSH_ASKPASS_MAIN%" "%PROMPT%" "%ZYGOS_SSH_ASKPASS_HANDLE%"
exit /b %ERRORLEVEL%
