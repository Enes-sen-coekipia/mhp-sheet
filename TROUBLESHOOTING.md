# Troubleshooting — MHP DataSheet

Guide de diagnostic rapide. Si rien ne marche, lis [DEPLOY.md](DEPLOY.md) d'abord.

## 🔥 L'app ne démarre pas du tout

### Symptôme : `nssm.exe start MHP-Datasheet-Backend` → service ne démarre pas

```powershell
# 1. Voir l'erreur dans les logs
Get-Content C:\MHP\mhp-datasheet\logs\backend.err.log -Tail 50

# 2. Si "ModuleNotFoundError" ou "ImportError" :
cd C:\MHP\mhp-datasheet
.\backend\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt

# 3. Si "Connection refused" sur PostgreSQL :
Get-Service postgresql*  # doit dire Running
# Vérifier credentials dans .env vs PG

# 4. Tester direct sans NSSM (pour voir l'erreur immédiate)
cd C:\MHP\mhp-datasheet
.\backend\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8001 --app-dir backend
# → si ça lance OK, le problème vient de la conf NSSM (relancer install.ps1)
```

## 🌐 L'app démarre mais inaccessible

### Symptôme : http://192.168.1.7:8081 → "Site inaccessible"

```powershell
# 1. Vérif Nginx tourne
Get-Service nginx*  # ou
Get-Process nginx -ErrorAction SilentlyContinue

# 2. Tester la conf Nginx
C:\nginx\nginx.exe -t

# 3. Vérif le port 8081 est ouvert dans Windows Firewall
New-NetFirewallRule -DisplayName "MHP DataSheet 8081" -Direction Inbound -LocalPort 8081 -Protocol TCP -Action Allow

# 4. Vérif que le backend tourne sur 8001 (interne)
Invoke-RestMethod http://127.0.0.1:8001/health
# → si ça répond OK : le problème est dans Nginx → vérifier le proxy_pass dans la conf

# 5. Reload Nginx après modif
C:\nginx\nginx.exe -s reload
```

## 🔐 Apps Script reçoit 401 Unauthorized

### Symptôme : dans les logs Apps Script, `mhpPost failed: 401`

**Cause** : le `MHP_TOKEN` dans `_helper.gs` ne correspond pas à `INGEST_API_TOKEN` dans `.env` côté serveur.

```powershell
# 1. Voir le token actuel côté serveur
Get-Content C:\MHP\mhp-datasheet\.env | Select-String "INGEST_API_TOKEN"

# 2. Tester avec curl avec ce token exact
$token = "valeur_du_token"
$headers = @{ 'X-API-Token' = $token }
Invoke-RestMethod -Uri "http://192.168.1.7:8081/api/tables" -Method Get -Headers $headers
# → si OK : le serveur accepte ce token. Re-coller dans Apps Script en vérifiant les espaces.

# 3. Régénérer un token et le pousser des 2 côtés
$nt = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | %{[char]$_})
# Mettre dans .env, restart backend, mettre dans _helper.gs côté Apps Script
```

## 🌍 Apps Script ne peut PAS joindre l'app (timeout / connection refused)

### Symptôme : dans les logs Apps Script, `Address unreachable` ou timeout

**Cause** : le serveur Windows MHP n'est pas joignable depuis internet (= depuis les serveurs Google où tourne Apps Script).

```powershell
# 1. Vérifier si l'IP est publique
# Depuis un téléphone EN 4G (pas en wifi MHP) :
# Aller sur http://<IP_MHP>:8081/api/health
# → si ça répond : c'est joignable depuis internet, le problème est ailleurs
# → sinon : il faut une exposition publique (cf. DEPLOY.md §Exposition internet)
```

**Solutions selon la situation** :
- Box accepte port forwarding → ouvrir 8081 → IP_publique:8081 vers 192.168.1.7:8081
- Pas de port forwarding possible → installer Cloudflare Tunnel (gratuit, cf. DEPLOY.md)

## 📊 Les formules type Sheets renvoient `#NAME?`

### Symptôme : `=SOMME(B1+C1)` → `#NAME?` dans l'interface

**Cause** : pack français HyperFormula non chargé.

```bash
# 1. Vérifier dans la console F12 du navigateur
# Tu dois voir au chargement :
# "✓ HyperFormula : pack français registered (SOMME, MOYENNE, SI, RECHERCHEV…)"
# Si tu vois "⚠️ Pack frFR HyperFormula non trouvé" :

# 2. Tester l'URL du pack
curl -I https://cdn.jsdelivr.net/npm/hyperformula/dist/languages/frFR.min.js
# → doit renvoyer 200

# 3. Si le serveur n'a pas accès internet sortant : héberger le pack en local
# Télécharger frFR.min.js et le mettre dans frontend/, puis adapter index.html
```

## 🐘 PostgreSQL refuse les connexions

### Symptôme : log `psycopg2.OperationalError: connection refused`

```powershell
# 1. Service PG tourne ?
Get-Service postgresql*

# 2. PG écoute sur 5432 ?
Test-NetConnection -ComputerName 127.0.0.1 -Port 5432

# 3. pg_hba.conf accepte les connexions depuis backend ?
# Si backend tourne localement : 127.0.0.1 doit être autorisé
# Fichier : C:\Program Files\PostgreSQL\18\data\pg_hba.conf
# Ligne attendue :
# host  pilotage_mhp  mhp_user  127.0.0.1/32  scram-sha-256

# 4. Si on a modifié pg_hba.conf : restart PG
Restart-Service postgresql-x64-18

# 5. Test connexion manuelle
$env:PGPASSWORD = "mot_de_passe"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -U mhp_user -d pilotage_mhp -c "SELECT 1;"
```

## 🐍 Un script Python plante en sandbox

### Symptôme : `ImportError: Module 'X' non autorisé en sandbox`

**Cause volontaire** : la sandbox bloque les imports dangereux (`os`, `subprocess`, `socket`, `sys`, `ctypes`…).

**Modules autorisés en sandbox** : `math`, `json`, `datetime`, `re`, `time`, `random`, `statistics`, `collections`, `itertools`, `functools`, `decimal`, `base64`, `csv`, `io`, `urllib.parse`, `mhp`, `mhp_lib`.

→ Si besoin d'un module hors liste : **désactiver la sandbox** pour ce script (toggle 🛡 dans l'éditeur Scripts). Risque : le code a accès complet au système.

## ⚡ Une formule SQL colonne ne calcule pas / renvoie NULL partout

### Symptôme : colonne avec formule SQL reste vide

```sql
-- 1. Vérifier que la formule est bien enregistrée
SELECT * FROM _mhp_formulas WHERE table_name = 'recap_bl';

-- 2. Tester la formule manuellement en SQL
SELECT (SELECT SUM(pfn(s.duree_nbr)) FROM suivi_equipe s WHERE s.n_bl_n_palette = r.n__bl)
FROM recap_bl r LIMIT 5;
-- → si NULL : la formule fait un SUM sur du texte non convertible, normal
-- → si erreur SQL : la formule est cassée, à corriger

-- 3. Re-appliquer la formule (forcer recalcul)
-- Via l'UI : menu colonne → "🔄 Recalculer la colonne"
-- OU via API :
-- POST /api/formula/apply {table, column, formula}
```

## 🕐 Un cron Apps Script ne déclenche plus

Vérifie côté Apps Script :
1. https://script.google.com/home → ouvrir le projet → ⏰ Déclencheurs
2. Le déclencheur doit être visible et "Actif"
3. Si erreurs : voir l'historique d'exécution (▶ Executions)

## 📝 Logs et debug

```powershell
# Backend stdout/stderr (capturé par NSSM)
Get-Content C:\MHP\mhp-datasheet\logs\backend.out.log -Tail 100 -Wait
Get-Content C:\MHP\mhp-datasheet\logs\backend.err.log -Tail 100

# Nginx (selon ta conf)
Get-Content C:\nginx\logs\access.log -Tail 50
Get-Content C:\nginx\logs\error.log -Tail 50

# PostgreSQL (selon version)
Get-Content "C:\Program Files\PostgreSQL\18\data\log\postgresql-*.log" -Tail 50

# Endpoints de debug
Invoke-RestMethod http://localhost:8081/api/health
Invoke-RestMethod http://localhost:8081/api/scripts/scheduled  # jobs cron actifs
Invoke-RestMethod http://localhost:8081/api/webhooks?limit=10  # derniers webhooks reçus
```

## 🆘 Tout reset (en dev local)

```powershell
cd C:\Users\Enes\Desktop\PROJETS\mhp-datasheet
docker compose down -v          # ⚠️ Supprime aussi la BD
docker compose up -d --build
```

En prod : **NE JAMAIS `down -v`**. Voir [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
