@echo off
setlocal
cd /d "%~dp0"
set "TEMP=%~dp0work\temp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
set "npm_config_cache=%~dp0work\cache\npm"
if not exist "%~dp0runtime\node\node.exe" (
  echo Freshwater: bundled Node 22 missing. Use the complete Windows release package.
  exit /b 1
)
"%~dp0runtime\node\node.exe" "%~dp0tools\windows\cli.cjs" %*
exit /b %errorlevel%
