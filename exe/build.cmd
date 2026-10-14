@echo off
rem Build bl-player, the minimal WebView2 host. ASCII only: cmd.exe parses this
rem file in the OEM code page, so non-ASCII bytes corrupt line continuations.
setlocal
set "VCVARS=D:\Program Files\1\VC\Auxiliary\Build\vcvars64.bat"
set "SDKROOT=D:\Windows Kits\10"
set "SDKVER=10.0.26100.0"
set "SDKBIN=%SDKROOT%\bin\%SDKVER%\x64"
set "WVPKG=%~dp0sdk\pkg\build\native"
cd /d "%~dp0"

if not exist build\app.rc (
  echo ERROR: build\app.rc not found.
  echo        Run:  node src\pack-exe.js ^<project.sb3^>
  exit /b 1
)
if not exist build\obj mkdir build\obj
if not exist build\obj-dyn mkdir build\obj-dyn

call "%VCVARS%" >nul
rem The Windows SDK is installed but NOT registered, so vcvars64.bat leaves
rem WindowsSdkDir empty and the include/lib paths have to be added by hand.
rem winrt\ is required too: WebView2.h includes <EventToken.h>, which ships
rem only under Include\<ver>\winrt\ and not under um\.
set "INCLUDE=%INCLUDE%;%SDKROOT%\Include\%SDKVER%\ucrt;%SDKROOT%\Include\%SDKVER%\um;%SDKROOT%\Include\%SDKVER%\shared;%SDKROOT%\Include\%SDKVER%\winrt;%WVPKG%\include"
set "LIB=%LIB%;%SDKROOT%\Lib\%SDKVER%\ucrt\x64;%SDKROOT%\Lib\%SDKVER%\um\x64;%WVPKG%\x64"
set "RC=%SDKBIN%\rc.exe"
if not exist "%RC%" set "RC=rc.exe"

"%RC%" /nologo /fo build\obj\app.res build\app.rc
if errorlevel 1 ( echo RC FAILED & exit /b 1 )

set "COMMON=/nologo /utf-8 /std:c++17 /EHsc /W4 /O2 /MT /GS- /DUNICODE /D_UNICODE"
set "LIBS=ole32.lib shell32.lib shlwapi.lib user32.lib gdi32.lib advapi32.lib version.lib"
set "LNKOPTS=/SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT /OPT:REF /OPT:ICF /INCREMENTAL:NO"

rem Variant A: WebView2 loader linked statically -> one self-contained exe.
cl %COMMON% /Fo:build\obj\ /Fe:build\bl-player.exe src\main.cpp build\obj\app.res ^
   /link %LNKOPTS% %LIBS% WebView2LoaderStatic.lib
if errorlevel 1 ( echo CL STATIC FAILED & exit /b 1 )

rem Variant B: loader as a sidecar DLL -> smaller exe, but two files to ship.
cl %COMMON% /Fo:build\obj-dyn\ /Fe:build\bl-player-dyn.exe src\main.cpp build\obj\app.res ^
   /link %LNKOPTS% %LIBS% "%WVPKG%\x64\WebView2Loader.dll.lib"
if errorlevel 1 ( echo CL DYNAMIC FAILED & exit /b 1 )
copy /y "%WVPKG%\x64\WebView2Loader.dll" build\WebView2Loader.dll >nul

echo BUILD OK
endlocal
