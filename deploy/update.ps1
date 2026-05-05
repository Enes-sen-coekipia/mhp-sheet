# ============================================================
#  MHP DataSheet — mise à jour rapide (git pull + restart)
#
#  Usage :
#    .\deploy\update.ps1
# ============================================================

param(
    [string]$ProjectDir   = "C:\MHP\mhp-datasheet",
    [string]$NssmPath     = "C:\nssm\nssm.exe",
    [string]$NginxPath    = "C:\nginx\nginx.exe",
    [string]$ServiceName  = "MHP-Datasheet-Backend",
    [switch]$ReloadNginx
)

$ErrorActionPreference = "Stop"
Write-Host "=== MHP DataSheet — update ===" -ForegroundColor Cyan

Push-Location $ProjectDir
try {
    # ─── git pull ───
    Write-Host "→ git pull..." -ForegroundColor Yellow
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull a échoué" }

    # ─── Reinstall dependencies si requirements.txt a changé ───
    Write-Host "→ Mise à jour des dépendances Python..." -ForegroundColor Yellow
    & "$ProjectDir\backend\.venv\Scripts\python.exe" -m pip install -r "$ProjectDir\backend\requirements.txt" --quiet

    # ─── Restart backend ───
    Write-Host "→ Restart $ServiceName..." -ForegroundColor Yellow
    & $NssmPath restart $ServiceName | Out-Null
    Start-Sleep -Seconds 2

    $Status = & $NssmPath status $ServiceName
    Write-Host "Status : $Status" -ForegroundColor Green

    # ─── Reload Nginx (si frontend modifié) ───
    if ($ReloadNginx) {
        Write-Host "→ Reload Nginx..." -ForegroundColor Yellow
        & $NginxPath -s reload
        Write-Host "Nginx rechargé." -ForegroundColor Green
    } else {
        Write-Host "(le frontend est servi statiquement par Nginx — relancer avec -ReloadNginx s'il a changé)" -ForegroundColor DarkGray
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "✓ Update terminé." -ForegroundColor Green
