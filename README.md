# MHP DataSheet

Interface tableur web connectée à PostgreSQL — remplace Google Sheets sans dépendre des formules RECHERCHEV.

## Lancer en local

```bash
# 1. Copier le template d'environnement
cp .env.example .env
# Éditer .env et changer au minimum POSTGRES_PASSWORD, DB_PASSWORD et API_PASSWORD

# 2. Démarrer
docker compose up --build
```

→ Interface : http://localhost:3000 (login : voir `API_USERNAME` / `API_PASSWORD` dans `.env`)
→ API       : http://localhost:8000 (Basic Auth)
→ Swagger   : http://localhost:8000/docs

## Architecture

```
frontend (nginx:3000)  ──>  backend (FastAPI:8000, Basic Auth)  ──>  PostgreSQL:5432
                                  │
                                  └─ pool psycopg2, whitelist tables/colonnes,
                                     validation formules SQL (blacklist DDL/DML)
```

## Fonctionnalités

- Visualisation de toutes les tables PostgreSQL (les tables internes `_*` sont masquées)
- Édition de cellules (double-clic / F2 / Enter), sauvegarde **en batch** (Ctrl+S ou bouton 💾)
- Pagination serveur (limit/offset) — utile pour `mouvements` (370 000 lignes)
- Ajout de colonnes avec formules SQL (remplace RECHERCHEV)
- Ajout / suppression de lignes
- Tri / filtrage des cellules vides
- Navigation clavier (flèches, Enter, F2, Delete, Escape)
- Suppression d'une formule (la colonne reste, plus recalculée)

## Sécurité

| Garde-fou | Détail |
|-----------|--------|
| Auth | HTTP Basic, comparaison constant-time |
| Identifiants SQL | Whitelist via `information_schema` avant toute interpolation |
| Formules SQL | Blacklist regex (`INSERT|UPDATE|DELETE|DROP|;|--|...`) + max 4000 chars |
| CORS | Vide par défaut (même origine via Nginx) |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| BD | Bind sur `127.0.0.1:5433` uniquement |

⚠️ **Les formules SQL** restent puissantes (lecture libre sur toute la BD via `mhp_user`).
Ne donner les credentials qu'aux utilisateurs de confiance.

## Formules SQL pour remplacer RECHERCHEV

Sélectionner une cellule de la colonne, cliquer **Modifier formule**, écrire l'expression :

```sql
-- RECHERCHEV durée
(SELECT SUM(pfn(s.duree_nbr)) FROM suivi_equipe s WHERE s.n_bl_n_palette = recap_bl.n__bl)

-- RECHERCHEV date
(SELECT MIN(s.date) FROM suivi_equipe s WHERE s.n_bl_n_palette = recap_bl.n__bl)

-- RECHERCHEV préparateur
(SELECT MIN(s.code) FROM suivi_equipe s WHERE s.n_bl_n_palette = recap_bl.n__bl)

-- Calcul productivité
pfn(duree) / NULLIF(pfn(sum_de_um), 0)
```

Fonctions disponibles : `pfn()` (nombre fr → float), `pfd()` (date fr → date), toutes les fonctions PostgreSQL en lecture.

## Connexion à la BD MHP en prod

Dans `.env` :

```
DB_HOST=192.168.x.x        # IP du serveur Windows client
DB_PORT=5432
DB_NAME=pilotage_mhp
DB_USER=mhp_user
DB_PASSWORD=••••••
```

Vérifier que PostgreSQL accepte les connexions distantes (`pg_hba.conf`).

## Réinitialiser les données de test

```bash
docker compose down -v && docker compose up --build
```
