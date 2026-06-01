# Backup & Restore — MHP DataSheet

Procédures de sauvegarde et restauration de la BD `pilotage_mhp`.

## Quoi sauvegarder ?

| Élément | Pourquoi | Méthode |
|---------|----------|---------|
| BD PostgreSQL `pilotage_mhp` | Données métier (toutes les tables) | `pg_dump` |
| `.env` | Mots de passe + token API | Copie fichier |
| Code Git | Versions de l'app | `git` (déjà sur GitHub) |
| Logs backend | Audit/debug | Copie `logs\backend.*.log` |

## Backup BD

### Backup manuel (à faire avant toute mise à jour majeure)

```powershell
$date = Get-Date -Format "yyyy-MM-dd_HH-mm"
$backupDir = "C:\MHP\backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir }

# Variables (à adapter)
$pgHost = "127.0.0.1"
$pgPort = "5432"
$pgUser = "mhp_user"
$pgDb   = "pilotage_mhp"
$env:PGPASSWORD = "<mot_de_passe>"

# Backup complet (schéma + données) en format custom (compressé, restauration sélective possible)
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" `
  -h $pgHost -p $pgPort -U $pgUser -d $pgDb `
  -F c -f "$backupDir\pilotage_mhp_$date.dump"

# Vérifier la taille (devrait pas être 0 octets)
Get-Item "$backupDir\pilotage_mhp_$date.dump" | Select-Object Name, Length, LastWriteTime

# Cleanup variable env
Remove-Item Env:PGPASSWORD
```

→ Tu obtiens un fichier `C:\MHP\backups\pilotage_mhp_2026-05-06_14-30.dump`.

### Backup automatique quotidien

Crée un script `C:\MHP\scripts\backup-daily.ps1` :

```powershell
$date = Get-Date -Format "yyyy-MM-dd"
$backupDir = "C:\MHP\backups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir }

$env:PGPASSWORD = "<mot_de_passe>"

& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" `
  -h 127.0.0.1 -U mhp_user -d pilotage_mhp `
  -F c -f "$backupDir\daily_$date.dump"

# Rétention : garder 30 derniers jours
Get-ChildItem $backupDir -Filter "daily_*.dump" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item

Remove-Item Env:PGPASSWORD
```

Planifier via **Planificateur de tâches Windows** :
- Programme : `powershell.exe`
- Arguments : `-NoProfile -ExecutionPolicy Bypass -File C:\MHP\scripts\backup-daily.ps1`
- Déclencheur : tous les jours à 02:00

### Backup du `.env`

```powershell
Copy-Item C:\MHP\mhp-datasheet\.env "C:\MHP\backups\env_$(Get-Date -Format 'yyyy-MM-dd').txt"
```

⚠️ Le `.env` contient des secrets. **Ne pas commiter dans git**. Le stocker dans un coffre-fort partagé (1Password, Bitwarden, KeePass) ou un partage Windows à accès restreint.

## Restore BD

### Restore complet (catastrophe / rollback)

```powershell
$dumpFile = "C:\MHP\backups\pilotage_mhp_2026-05-06_14-30.dump"
$env:PGPASSWORD = "<mot_de_passe>"

# 1. Arrêter le backend (sinon connexions ouvertes empêchent le DROP)
C:\nssm\nssm.exe stop MHP-Datasheet-Backend

# 2. Drop + recreate la BD
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -U postgres -c "DROP DATABASE pilotage_mhp;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -U postgres -c "CREATE DATABASE pilotage_mhp OWNER mhp_user;"

# 3. Restore depuis le dump
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
  -h 127.0.0.1 -U mhp_user -d pilotage_mhp -v $dumpFile

# 4. Redémarrer le backend
C:\nssm\nssm.exe start MHP-Datasheet-Backend

Remove-Item Env:PGPASSWORD
```

### Restore partiel (une table)

Tu as supprimé `recap_bl` par erreur et tu veux la récupérer depuis un dump d'hier :

```powershell
$dumpFile = "C:\MHP\backups\daily_2026-05-05.dump"
$env:PGPASSWORD = "<mot_de_passe>"

# Restore SEULEMENT la table recap_bl
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
  -h 127.0.0.1 -U mhp_user -d pilotage_mhp `
  -t recap_bl -v --data-only $dumpFile

# OU si la table n'existe plus (besoin du schéma aussi) :
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
  -h 127.0.0.1 -U mhp_user -d pilotage_mhp `
  -t recap_bl -v $dumpFile
```

## Rollback de l'application

### Revenir à une version précédente

```powershell
cd C:\MHP\mhp-datasheet

# Voir les versions disponibles
git log --oneline -20

# Revenir à un commit précis
git checkout <commit-hash>

# Redéployer
.\deploy\update.ps1

# Pour revenir sur main après les tests
git checkout main
```

### Revenir au tag stable précédent (si tu utilises des tags)

```powershell
git tag -l                       # liste les tags
git checkout tags/v1.0.0         # bascule sur v1.0.0
.\deploy\update.ps1              # reprend l'install
```

→ **Reco** : à chaque déploiement majeur, créer un tag :
```powershell
git tag -a v1.0.0 -m "Première mise en prod chez MHP"
git push --tags
```

## Disaster recovery — perte totale du serveur

Procédure pour remonter from scratch (nouveau serveur Windows) :

```powershell
# 1. Installer pré-requis : Python 3.12, PostgreSQL 18, Git, Nginx, NSSM
# (cf. DEPLOY.md §Pré-requis)

# 2. Cloner le repo
cd C:\MHP
git clone https://github.com/Enes-sen-coekipia/mhp-sheet.git mhp-datasheet

# 3. Restaurer le .env depuis le coffre
# Copier le dernier .env sauvegardé dans C:\MHP\mhp-datasheet\.env

# 4. Restaurer la BD depuis le dernier dump
$env:PGPASSWORD = "<mot_de_passe>"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE pilotage_mhp OWNER mhp_user;"
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -U mhp_user -d pilotage_mhp -v "C:\MHP\backups\daily_latest.dump"

# 5. Lancer l'install service
cd C:\MHP\mhp-datasheet
Set-ExecutionPolicy -Scope Process Bypass -Force
.\deploy\install.ps1

# 6. Reconfigurer Nginx
Copy-Item deploy\mhp-datasheet.nginx.conf C:\nginx\conf\sites\mhp-datasheet.conf
C:\nginx\nginx.exe -s reload

# 7. Tester
Invoke-RestMethod http://localhost:8081/api/health
```

**Temps estimé** : 30-60 min (le plus long = installer Python/PG si pas encore là).

## Tester ses backups

⚠️ Un backup non testé = un backup qui n'existe pas. **À faire tous les 3 mois** :

```powershell
# Sur le serveur MHP, créer une BD de test :
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE pilotage_test OWNER mhp_user;"

# Restaurer le dernier dump dedans
$env:PGPASSWORD = "<mot_de_passe>"
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -U mhp_user -d pilotage_test -v "C:\MHP\backups\daily_latest.dump"

# Vérifier que les tables sont là
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U mhp_user -d pilotage_test -c "SELECT count(*) FROM stock_it; SELECT count(*) FROM recap_bl; SELECT count(*) FROM suivi_equipe;"

# Cleanup
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "DROP DATABASE pilotage_test;"
```

→ Si le restore fonctionne et que les counts ressemblent à la prod : ✅ ton backup est sain.
