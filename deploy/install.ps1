# ============================================================
#  MHP DataSheet — install / mise à jour du backend en service Windows
#  Idempotent : peut être relancé autant de fois que nécessaire.
#
#  Pré-requis sur le serveur :
#    - Python 3.12+ dans le PATH (https://www.python.org/downloads/windows/)
#    - NSSM dans C:\nssm\nssm.exe
#    - Le repo cloné dans C:\MHP\mhp-datasheet
#    - Un fichier .env créé à la racine du projet (copier .env.prod.example)
#
#  Usage (PowerShell admin) :
#    Set-ExecutionPolicy -Scope Process Bypass
#    .\deploy\install.ps1
# ============================================================

param(
    [string]$ProjectDir  = "C:\MHP\mhp-datasheet",
    [string]$NssmPath    = "C:\nssm\nssm.exe",
    [string]$ServiceName = "MHP-Datasheet-Backend",
    [int]   $BackendPort = 8001
)

$ErrorActionPreference = "Stop"
Write-Host "=== MHP DataSheet — install / update backend ===" -ForegroundColor Cyan

# ─── Vérifications ───
if (-not (Test-Path $ProjectDir))                  { throw "ProjectDir introuvable : $ProjectDir" }
if (-not (Test-Path $NssmPath))                    { throw "NSSM introuvable : $NssmPath" }
$BackendDir = Join-Path $ProjectDir "backend"
$VenvDir    = Join-Path $BackendDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$EnvFile    = Join-Path $ProjectDir ".env"
$LogsDir    = Join-Path $ProjectDir "logs"
if (-not (Test-Path $EnvFile)) {
    throw ".env manquant. Copier .env.prod.example en .env et le remplir : Copy-Item .env.prod.example .env ; notepad .env"
}

# ─── Dossier logs ───
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

# ─── Venv Python ───
if (-not (Test-Path $VenvPython)) {
    Write-Host "→ Création du venv Python..." -ForegroundColor Yellow
    python -m venv $VenvDir
    if (-not (Test-Path $VenvPython)) { throw "Échec création venv. Python 3.12+ est-il installé et dans le PATH ?" }
}

# ─── Dependencies ───
Write-Host "→ Installation des dépendances Python..." -ForegroundColor Yellow
& $VenvPython -m pip install --upgrade pip --quiet
& $VenvPython -m pip install -r (Join-Path $BackendDir "requirements.txt") --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install a échoué" }

# ─── Service NSSM ───
$ServiceExists = $null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
if ($ServiceExists) {
    Write-Host "→ Arrêt du service existant..." -ForegroundColor Yellow
    & $NssmPath stop $ServiceName confirm | Out-Null
} else {
    Write-Host "→ Création du service $ServiceName..." -ForegroundColor Yellow
    & $NssmPath install $ServiceName $VenvPython | Out-Null
}

# Configuration (re-appliquée à chaque exécution → toujours à jour)
& $NssmPath set $ServiceName Application      $VenvPython | Out-Null
& $NssmPath set $ServiceName AppDirectory     $ProjectDir | Out-Null
& $NssmPath set $ServiceName AppParameters    "-m uvicorn main:app --host 127.0.0.1 --port $BackendPort --app-dir backend" | Out-Null
& $NssmPath set $ServiceName Start            SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName Description      "MHP DataSheet — backend FastAPI" | Out-Null
& $NssmPath set $ServiceName AppStdout        (Join-Path $LogsDir "backend.out.log") | Out-Null
& $NssmPath set $ServiceName AppStderr        (Join-Path $LogsDir "backend.err.log") | Out-Null
& $NssmPath set $ServiceName AppRotateFiles   1 | Out-Null
& $NssmPath set $ServiceName AppRotateOnline  1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes   10485760 | Out-Null

Write-Host "→ Démarrage..." -ForegroundColor Yellow
& $NssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$Status = & $NssmPath status $ServiceName
Write-Host ""
Write-Host "Service status : $Status" -ForegroundColor Green

# Test de santé
Write-Host "→ Test /health..." -ForegroundColor Yellow
try {
    $r = Invoke-RestMethod "http://127.0.0.1:$BackendPort/health" -TimeoutSec 5
    Write-Host "Health : $($r | ConvertTo-Json -Compress)" -ForegroundColor Green
    Write-Host ""
    Write-Host "✓ Backend opérationnel sur http://127.0.0.1:$BackendPort" -ForegroundColor Green
    Write-Host "  Étape suivante : configurer Nginx (voir deploy\mhp-datasheet.nginx.conf)" -ForegroundColor Cyan
} catch {
    Write-Warning "Health check échoué : $_"
    Write-Host "Voir logs : $LogsDir\backend.err.log" -ForegroundColor Yellow
    Get-Content (Join-Path $LogsDir "backend.err.log") -Tail 20 -ErrorAction SilentlyContinue
}
