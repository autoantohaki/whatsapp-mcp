@echo off
rem Opens Claude Code in this folder with live WhatsApp messages turned on.
rem Claude Code asks once to confirm the "development channel"; choose to allow it.
cd /d "%~dp0"
set WHATSAPP_LIVE=1
where claude >nul 2>nul || (
  echo Claude Code is not installed for the terminal yet. Installing it...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
claude --dangerously-load-development-channels server:whatsapp %*
