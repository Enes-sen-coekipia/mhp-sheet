# Déploiement prod — serveur Windows MHP

Stack identique à `MHP_app` : **Python venv + uvicorn (NSSM) + Nginx natif + PostgreSQL natif**. Pas de Docker.

```
Utilisateur LAN
    │ HTTP :8081
    ▼
Nginx (existant, C:\nginx\)  →  C:\MHP\mhp-datasheet\frontend  (HTML/CSS/JS statiques)
    │ proxy /api/*
    ▼
uvicorn (service NSSM)  127.0.0.1:8001  →  PostgreSQL 18 local
```

## Pré-requis sur le serveur (une seule fois)

| Outil | Vérification | Si absent |
|---|---|---|
| **Python 3.12+** | `python --version` | Installer depuis [python.org](https://www.python.org/downloads/windows/) en cochant "Add to PATH" |
| **NSSM** | `Test-Path C:\nssm\nssm.exe` | Déjà présent (utilisé par MHP_app) |
| **Nginx** | `Test-Path C:\nginx\nginx.exe` | Déjà présent (utilisé par MHP_app) |
| **PostgreSQL 18** | `Get-Service postgresql*` | Déjà installé par le client |
| **Git** | `git --version` | [git-scm.com](https://git-scm.com/download/win) |

## 1. Cloner le repo

```powershell
cd C:\MHP
git clone https://github.com/Enes-sen-coekipia/mhp-sheet.git mhp-datasheet
cd C:\MHP\mhp-datasheet
```

## 2. Créer le `.env`

```powershell
Copy-Item .env.prod.example .env
notepad .env
```

Contenu à mettre :

```
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=pilotage_mhp
DB_USER=mhp_user
DB_PASSWORD=METTRE_LE_VRAI_MOT_DE_PASSE

LOG_LEVEL=INFO
POOL_MIN_SIZE=1
POOL_MAX_SIZE=10
DEFAULT_PAGE_SIZE=500
MAX_PAGE_SIZE=5000

API_USERNAME=
API_PASSWORD=
```

## 3. Préparer la BD (UNE SEULE FOIS, dans pgAdmin/psql)

```sql
CREATE OR REPLACE FUNCTION pfn(val TEXT) RETURNS FLOAT AS $$
BEGIN
  IF val IS NULL OR trim(val) = '' THEN RETURN NULL; END IF;
  RETURN replace(regexp_replace(trim(val), '[^\d,\-]', '', 'g'), ',', '.')::float;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION pfd(val TEXT) RETURNS DATE AS $$
BEGIN
  IF val IS NULL OR trim(val) = '' THEN RETURN NULL; END IF;
  IF val ~ '^\d{1,2}/\d{1,2}/\d{4}$' THEN RETURN TO_DATE(val, 'DD/MM/YYYY'); END IF;
  IF val ~ '^\d{1,2}/\d{1,2}/\d{2}$' THEN RETURN TO_DATE(val, 'DD/MM/YY'); END IF;
  IF val ~ '^\d{4}-\d{2}-\d{2}' THEN RETURN val::date; END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS _mhp_formulas (
    table_name  TEXT,
    column_name TEXT,
    formula     TEXT,
    PRIMARY KEY (table_name, column_name)
);

-- Index pour accélérer les RECHERCHEV-via-SQL
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_n_bl_n_palette ON suivi_equipe(n_bl_n_palette);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_client         ON suivi_equipe(client);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_date           ON suivi_equipe(date);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_code           ON suivi_equipe(code);
CREATE INDEX IF NOT EXISTS idx_recap_bl_n__bl              ON recap_bl(n__bl);
CREATE INDEX IF NOT EXISTS idx_recap_bl_client             ON recap_bl(client);
CREATE INDEX IF NOT EXISTS idx_recap_bl_date               ON recap_bl(date);

-- Module Scripts (équivalent Apps Script)
CREATE TABLE IF NOT EXISTS _mhp_scripts (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT,
    language      TEXT NOT NULL DEFAULT 'python',
    code          TEXT NOT NULL DEFAULT '',
    trigger_type  TEXT NOT NULL DEFAULT 'manual',
    trigger_cron  TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS _mhp_script_runs (
    id            SERIAL PRIMARY KEY,
    script_id     INTEGER REFERENCES _mhp_scripts(id) ON DELETE CASCADE,
    started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMP,
    status        TEXT NOT NULL DEFAULT 'running',
    output        TEXT,
    error         TEXT,
    triggered_by  TEXT NOT NULL DEFAULT 'manual',
    duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_script_runs_script ON _mhp_script_runs(script_id, started_at DESC);
```

100% non-destructif (`CREATE OR REPLACE` / `IF NOT EXISTS`). Aucun risque pour les données existantes.

## 4. Installer le service backend

PowerShell **en admin** :

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd C:\MHP\mhp-datasheet
.\deploy\install.ps1
```

Le script :
1. Crée un venv Python dans `backend\.venv`
2. Installe les dépendances (`fastapi`, `psycopg2-binary`, etc.)
3. Crée le service Windows `MHP-Datasheet-Backend` via NSSM
4. Le démarre et fait un check `/health`

À la fin tu dois voir `Service status : SERVICE_RUNNING` et `Health : {"status":"ok","db":"connected"}`.

Si erreur, voir `C:\MHP\mhp-datasheet\logs\backend.err.log`.

## 5. Configurer Nginx

### Si ton `nginx.conf` inclut un dossier `sites/`

```powershell
Copy-Item C:\MHP\mhp-datasheet\deploy\mhp-datasheet.nginx.conf C:\nginx\conf\sites\mhp-datasheet.conf
C:\nginx\nginx.exe -s reload
```

### Sinon (tout est dans `nginx.conf`)

Ouvrir `C:\nginx\conf\nginx.conf`, copier-coller le contenu de `deploy\mhp-datasheet.nginx.conf` à l'intérieur du bloc `http { ... }`, sauver, puis :

```powershell
C:\nginx\nginx.exe -s reload
```

## 6. Tester

Ouvrir un navigateur :

- Sur le serveur : http://localhost:8081
- Depuis le LAN : http://192.168.1.7:8081 *(remplacer par l'IP réelle)*

## Mises à jour ultérieures

Depuis ton PC :

```powershell
git add . ; git commit -m "..." ; git push
```

Sur le serveur :

```powershell
cd C:\MHP\mhp-datasheet
.\deploy\update.ps1
# Si le frontend a aussi changé : .\deploy\update.ps1 -ReloadNginx
```

## Commandes utiles

```powershell
# Status du service
C:\nssm\nssm.exe status MHP-Datasheet-Backend

# Restart manuel
C:\nssm\nssm.exe restart MHP-Datasheet-Backend

# Stop / start
C:\nssm\nssm.exe stop  MHP-Datasheet-Backend
C:\nssm\nssm.exe start MHP-Datasheet-Backend

# Logs (suivre en direct)
Get-Content C:\MHP\mhp-datasheet\logs\backend.out.log -Tail 50 -Wait
Get-Content C:\MHP\mhp-datasheet\logs\backend.err.log -Tail 50 -Wait

# Test backend en direct (court-circuite Nginx)
Invoke-RestMethod http://127.0.0.1:8001/health
Invoke-RestMethod http://127.0.0.1:8001/tables

# Suppression complète du service (en cas de besoin)
C:\nssm\nssm.exe stop   MHP-Datasheet-Backend confirm
C:\nssm\nssm.exe remove MHP-Datasheet-Backend confirm
```

## Ports utilisés

| Port | Service | Visibilité |
|------|---------|------------|
| 8081 | Nginx (frontend MHP DataSheet) | LAN |
| 8001 | uvicorn backend | Interne (127.0.0.1 uniquement) |
| 5432 | PostgreSQL | Local |

Pas de conflit avec `MHP_app` (8080), `MySQL` (3306) ou `Backend MHP_app` (8000).

## Configuration OAuth Google (Gmail / Drive / Sheets)

Pour permettre aux scripts d'utiliser `mhp.gmail`, `mhp.drive`, `mhp.sheets`.

### A. Côté Google Cloud Console (une seule fois)

1. **Créer un projet GCP** : https://console.cloud.google.com → "Sélectionner un projet" → "Nouveau projet" → nom : `mhp-datasheet`.

2. **Activer les API** : Menu → APIs & Services → Bibliothèque → activer ces 3 APIs :
   - **Gmail API**
   - **Google Drive API**
   - **Google Sheets API**

3. **Configurer l'écran de consentement OAuth** : Menu → APIs & Services → "OAuth consent screen" → Type : **Externe** (ou Interne si compte Google Workspace MHP) → Nom application : `MHP DataSheet` → email support : email du client → Save.
   - Ajouter dans "Test users" l'email du compte robot qu'on va connecter (ex : `compte-mhp@gmail.com`). Tant que l'app est en mode "Testing", seuls ces utilisateurs peuvent l'utiliser.

4. **Créer les credentials OAuth 2.0** : Menu → APIs & Services → Credentials → "+ CREATE CREDENTIALS" → "OAuth client ID" → Type : **Web application** → Nom : `MHP DataSheet Web` → **URIs de redirection autorisées** :
   ```
   http://192.168.1.7:8081/api/integrations/google/callback
   http://localhost:3000/api/integrations/google/callback
   ```
   (la 1ʳᵉ pour la prod, la 2ᵉ pour le dev)
   → "Create" → noter le **Client ID** et le **Client secret**.

### B. Côté serveur Windows

Dans `C:\MHP\mhp-datasheet\.env`, ajouter :

```
GOOGLE_OAUTH_CLIENT_ID=xxxxxxxxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
GOOGLE_OAUTH_REDIRECT_URI=http://192.168.1.7:8081/api/integrations/google/callback
```

Restart :

```powershell
C:\nssm\nssm.exe restart MHP-Datasheet-Backend
```

### C. Connecter le compte

1. Ouvrir http://192.168.1.7:8081
2. Cliquer **🔌 Intégrations** dans le header
3. Cliquer **🔗 Connecter un compte Google** → popup Google
4. Choisir le compte robot, accepter les permissions
5. La popup se ferme, le statut passe à **✓ Connecté**

Les scripts peuvent maintenant utiliser `mhp.gmail`, `mhp.drive`, `mhp.sheets`. Le refresh token est stocké en BD et auto-utilisé quand l'access token expire (1h).

### D. Migration de tes scripts Apps Script

Voici comment réécrire `importStockItReport()` (Apps Script → notre app) :

```python
import mhp

# Récupère le mail le plus récent avec le libellé "stockit"
msg = mhp.gmail.get_latest_with_label('stockit', max_age_days=2)
if not msg:
    mhp.log("Aucun mail trouvé"); raise SystemExit

# Première pièce jointe
atts = mhp.gmail.get_attachments(msg['id'])
if not atts:
    mhp.log("Pas de pièce jointe"); raise SystemExit
att = atts[0]

# Upload + conversion XLSX → Google Sheets
sheet_file = mhp.drive.upload_and_convert_to_sheets(
    name=f"Temp_StockIt_{att['filename']}",
    content=att['data'],
)

# Export en CSV
csv_text = mhp.drive.export_csv(sheet_file['id'])
mhp.drive.delete(sheet_file['id'])  # cleanup

# Parse CSV et insère dans Postgres
import csv as _csv, io
rows = list(_csv.reader(io.StringIO(csv_text), delimiter=','))
data_rows = rows[1:]  # skip header

t = mhp.table('stock_it')
n = t.append_rows([dict(zip(t.columns, r)) for r in data_rows])
mhp.log(f"✅ {n} lignes importées dans stock_it")
```

À programmer en cron type `0 7 * * *` (tous les jours à 7h) dans la modale Scripts.

## Restriction LAN (recommandé)

Décommenter le bloc `allow / deny` dans `deploy/mhp-datasheet.nginx.conf` (ou la copie dans `C:\nginx\conf\sites\`), adapter le subnet (`192.168.1.0/24` par défaut), puis :

```powershell
C:\nginx\nginx.exe -s reload
```
