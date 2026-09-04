@echo off
if not "%SMITHERS_FAKE_NODE_LOG%"=="" (
  node "%~dp0fake-node-log.js" %*
)
if "%SMITHERS_FAKE_NODE_EXIT%"=="" exit /b 0
exit /b %SMITHERS_FAKE_NODE_EXIT%
