@echo off
title OrbSniper build
echo ==========================================
echo   Building OrbSniper.exe (GUI)
echo ==========================================
echo.

call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

echo.
echo Running checks...
call npm test
if errorlevel 1 goto :testfail

call npm run dist
if errorlevel 1 goto :fail

echo.
echo ==========================================
echo   Done: dist\OrbSniper.exe
echo   (c) 2026 synaps_ss - tg @synaps_ss
echo ==========================================
pause
exit /b 0

:testfail
echo.
echo CHECKS FAILED - not building. Fix the failures above.
pause
exit /b 1

:fail
echo.
echo BUILD FAILED - see errors above.
pause
exit /b 1
