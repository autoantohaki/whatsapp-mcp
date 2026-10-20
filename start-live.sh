#!/usr/bin/env bash
# Opens Claude Code in this folder with live WhatsApp messages turned on.
cd "$(dirname "$0")"
export WHATSAPP_LIVE=1
exec claude --dangerously-load-development-channels server:whatsapp "$@"
