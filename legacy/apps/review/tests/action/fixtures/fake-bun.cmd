@echo off
if not "%SMITHERS_FAKE_BUN_LOG%"=="" (
  node "%~dp0fake-bun-log.js" %*
)
if "%SMITHERS_FAKE_BUN_EXIT%"=="" exit /b 0
exit /b %SMITHERS_FAKE_BUN_EXIT%
