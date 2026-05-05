# Déploiement prod — serveur Windows MHP

Architecture : 2 conteneurs Docker (`backend` FastAPI + `frontend` Nginx). Le PostgreSQL **n'est pas containérisé** : on attaque directement le PG 18 du serveur Windows.

## Pré-requis (une seule fois sur le serveur)

1. **Docker Desktop pour Windows** installé et démarré.
2. **PostgreSQL 18** installé sur le serveur (déjà fait par le client) avec la base `pilotage_mhp` et l'utilisateur `mhp_user`.
3. Vérifier que `pg_hba.conf` accepte les connexions depuis Docker :
   ```
   host    pilotage_mhp    mhp_user    172.16.0.0/12    scram-sha-256
   host    pilotage_mhp    mhp_user    127.0.0.1/32     scram-sha-256
   ```
   Et que `postgresql.conf` a `listen_addresses = '*'` (ou au moins `localhost`).
4. **Git** installé (pour cloner / pull).

## Premier déploiement

```powershell
# 1. Cloner dans C:\MHP (à côté de l'autre app)
cd C:\MHP
git clone <URL_DU_REPO> mhp-datasheet
cd mhp-datasheet

# 2. Créer le .env prod
copy .env.prod.example .env
notepad .env
# → mettre le vrai DB_PASSWORD
# → DB_HOST = host.docker.internal (PG sur le même serveur)

# 3. Build + démarrer
docker compose -f docker-compose.prod.yml up -d --build

# 4. Vérifier
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=30 backend
```

L'app est accessible sur **http://192.168.1.7:8081** (port 8081 pour ne pas entrer en conflit avec le 8080 de l'app `MHP_app` existante).

## Mises à jour ultérieures

```powershell
cd C:\MHP\mhp-datasheet
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## Service Windows (auto-démarrage)

Docker Desktop démarre automatiquement les conteneurs marqués `restart: unless-stopped` au boot du serveur. Aucune config NSSM nécessaire pour cette app.

Si Docker Desktop n'est pas en démarrage auto :
- Paramètres Docker Desktop → "Start Docker Desktop when you sign in"

## Indexation PG (à faire une fois sur la BD prod)

Pour accélérer les RECHERCHEV-via-SQL :

```powershell
# Depuis le serveur PG :
psql -U mhp_user -d pilotage_mhp -f init.sql
# Les CREATE TABLE/INSERT échoueront (tables existent déjà) — OK, on veut juste les CREATE INDEX IF NOT EXISTS
```

Ou plus propre, n'extraire que les indexes :

```sql
-- À copier-coller dans psql ou pgAdmin
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_n_bl_n_palette ON suivi_equipe(n_bl_n_palette);
CREATE INDEX IF NOT EXISTS idx_recap_bl_n__bl              ON recap_bl(n__bl);
CREATE INDEX IF NOT EXISTS idx_recap_bl_client             ON recap_bl(client);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_client         ON suivi_equipe(client);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_date           ON suivi_equipe(date);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_code           ON suivi_equipe(code);
CREATE INDEX IF NOT EXISTS idx_recap_bl_date               ON recap_bl(date);
```

## Restriction d'accès LAN

L'auth est désactivée. Pour limiter l'accès au LAN client, ajouter dans `nginx/nginx.conf` :

```
location / {
    allow 192.168.1.0/24;
    deny all;
    ...
}
```
puis `docker compose -f docker-compose.prod.yml restart frontend`.

## Commandes utiles

```powershell
# Logs en direct
docker compose -f docker-compose.prod.yml logs -f backend

# Redémarrer juste le backend (après pull)
docker compose -f docker-compose.prod.yml restart backend

# Tout arrêter
docker compose -f docker-compose.prod.yml down

# Statut
docker compose -f docker-compose.prod.yml ps
```

## Ports utilisés

| Port  | Service                           |
|-------|-----------------------------------|
| 8081  | Nginx frontend (mhp-datasheet)    |
| 8000  | Backend FastAPI (interne uniquement, pas exposé hors Docker) |
| 5432  | PostgreSQL host (existant)        |

Les ports `8080` (MHP_app) et `3306` (MySQL) ne sont **pas touchés**.
