@echo off
chcp 65001 >nul
title Growdy - configurar o Render
setlocal enabledelayedexpansion

cls
echo.
echo   ======================================================
echo      GROWDY - copiar e colar no Render
echo   ======================================================
echo.
echo   Como funciona:
echo.
echo   1. Este programa copia UM valor por vez.
echo   2. Voce vai no Render e cola com CTRL+V.
echo   3. Volta aqui e aperta uma tecla para o proximo.
echo.
echo   Deixe a pagina do Render aberta em outra janela.
echo.
pause

cls
echo.
echo   ---- PARTE 1 de 2: as tres credenciais ----
echo.
echo   No Render: Environment  ^>  Environment Variables
echo.
pause

call :env BASS_CLIENT_ID
call :env BASS_CLIENT_SECRET
call :env BASS_CHAVE_PIX

cls
echo.
echo   ---- PARTE 2 de 2: os quatro certificados ----
echo.
echo   No Render: Environment  ^>  Secret Files  ^>  Add Secret File
echo   Cada um tem um NOME exato. Preste atencao no nome.
echo.
pause

call :arquivo "certs\cashin\BASSPAGO_41.crt"  cashin.crt
call :arquivo "certs\cashin\BASSPAGO_41.key"  cashin.key
call :arquivo "certs\cashout\BASSPAGO_41.crt" cashout.crt
call :arquivo "certs\cashout\BASSPAGO_41.key" cashout.key

cls
echo.
echo   ======================================================
echo      ACABOU
echo   ======================================================
echo.
echo   Falta so o disco, que nao tem nada para copiar:
echo.
echo     Settings  ^>  Disks  ^>  Add Disk
echo     Mount Path:  /var/data
echo     Size:        1 GB
echo.
echo   Depois o Render faz o deploy sozinho. Para conferir,
echo   abra no navegador:
echo.
echo     https://growdy.onrender.com/api/saude
echo.
echo   Tem que aparecer:  {"ok":true,"bass":"autenticado"}
echo.
pause
exit /b

rem ---------------------------------------------------------
:env
powershell -NoProfile -Command "$l=(Select-String -Path '%~dp0.env' -Pattern '^%~1=' | Select-Object -First 1).Line; if($l){ $l.Substring($l.IndexOf('=')+1).Trim() | Set-Clipboard; exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo.
  echo   [ERRO] nao encontrei %~1 dentro do arquivo .env
  echo.
  pause
  goto :eof
)
cls
echo.
echo   COPIADO com sucesso.
echo.
echo   Agora no Render, em Environment Variables:
echo.
echo     Nome da variavel:  %~1
echo     Valor:             cole com CTRL+V
echo.
echo   Depois de colar, volte aqui e aperte uma tecla.
echo.
pause
goto :eof

rem ---------------------------------------------------------
:arquivo
powershell -NoProfile -Command "$p='%~dp0%~1'; if(Test-Path $p){ Get-Content -Raw $p | Set-Clipboard; exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo.
  echo   [ERRO] nao encontrei o arquivo %~1
  echo   Ele deveria estar em: %~dp0%~1
  echo.
  pause
  goto :eof
)
cls
echo.
echo   COPIADO com sucesso.
echo.
echo   Agora no Render, em Secret Files, clique Add Secret File:
echo.
echo     Filename:  %~2
echo     Contents:  cole com CTRL+V
echo.
echo   Confira que comeca com -----BEGIN
echo   Depois de salvar, volte aqui e aperte uma tecla.
echo.
pause
goto :eof
