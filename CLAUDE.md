# MHP DataSheet — Contexte projet pour Claude Code

## Vue d'ensemble

Application tableur web connectée à PostgreSQL pour le client MHP Transport.
Elle remplace Google Sheets comme interface de visualisation et d'édition des données,
sans dépendre du temps de chargement des formules RECHERCHEV.

## Stack technique

- **Frontend** : HTML/CSS/JS vanilla (3 fichiers : `index.html` / `styles.css` / `app.js`) servi par Nginx
- **Backend** : FastAPI (Python 3.12) — modules séparés (`main`, `config`, `db`, `security`, `auth`, `models`)
- **Base de données** : PostgreSQL 16 (Docker) ou PostgreSQL 18 (serveur Windows client)
- **Orchestration** : Docker Compose, secrets dans `.env` (jamais commité)
- **Auth** : HTTP Basic vérifié côté FastAPI (constant-time compare)

## Structure du projet

```
mhp-datasheet/
├── .env                       # Secrets (gitignored)
├── .env.example               # Template à copier en .env
├── .gitignore
├── docker-compose.yml
├── init.sql                   # Données de test + fonctions pfn() / pfd() + table _mhp_formulas
├── README.md
├── CLAUDE.md
├── backend/
│   ├── main.py                # FastAPI app + routes
│   ├── config.py              # Settings (pydantic-settings, lit .env)
│   ├── db.py                  # Pool psycopg2 + context manager
│   ├── security.py            # Whitelist tables/colonnes, validation formules
│   ├── auth.py                # HTTP Basic
│   ├── models.py              # Pydantic models (CellUpdate, NewRow, etc.)
│   ├── requirements.txt
│   └── Dockerfile             # Python 3.12-slim, non-root, healthcheck
├── frontend/
│   ├── index.html             # Structure HTML uniquement
│   ├── styles.css
│   └── app.js                 # Logique : auth, render, batch save, pagination
└── nginx/
    └── nginx.conf             # Proxy /api/ → backend:8000 + headers sécurité
```

## Endpoints API backend

Tous les endpoints (sauf `/health`) requièrent une authentification HTTP Basic.

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/health` | Statut connexion PostgreSQL (public) |
| GET | `/tables` | Liste les tables publiques (cache les `_*`) |
| GET | `/table/{name}?limit&offset` | Données + colonnes + total + flag `has_formula` |
| GET | `/table/{name}/formulas` | Récupérer les formules SQL enregistrées |
| PUT | `/cell` | Modifier une cellule |
| PUT | `/cells/batch` | Modifier plusieurs cellules en une transaction |
| POST | `/table/{name}/row` | Insérer une ligne |
| DELETE | `/table/{name}/row?primary_col&primary_val` | Supprimer une ligne |
| POST | `/table/{name}/column` | Ajouter une colonne (avec formule SQL optionnelle) |
| POST | `/formula/apply` | Appliquer une formule SQL sur toute une colonne |
| DELETE | `/formula?table&column` | Supprimer une formule (la colonne reste) |

## Sécurité

- **Whitelist stricte** : tout nom de table/colonne reçu du client est validé contre `information_schema` avant d'être concaténé en SQL — jamais de SQLi possible.
- **Formules SQL** : auth requise + blacklist regex (`INSERT|UPDATE|DELETE|DROP|;|--|/*|pg_*` etc.) + limite 4000 chars. Reste un feature puissant : ne donner les credentials qu'aux utilisateurs de confiance.
- **Auth** : HTTP Basic, comparaison constant-time (`secrets.compare_digest`).
- **CORS** : vide par défaut (même origine via Nginx). Configurable via `CORS_ORIGINS`.
- **Headers sécurité** Nginx : `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **PostgreSQL** : exposé uniquement sur `127.0.0.1:5433` côté host (non accessible LAN par défaut).

## Base de données PostgreSQL

**Toutes les credentials sont dans `.env`** — voir `.env.example` pour la liste des variables.

**Connexion locale (Docker test)** : `host=localhost port=5433 db=pilotage_mhp` (credentials dans `.env`)

**Connexion prod (serveur Windows client)** : pointer `DB_HOST` vers l'IP du serveur dans le `.env`.

**Fonctions utilitaires** :
- `pfn(val TEXT) → FLOAT` : convertit nombre français (`"11 707,00"`) en float
- `pfd(val TEXT) → DATE` : convertit date française (JJ/MM/AAAA) en DATE

**Table de métadonnées** : `_mhp_formulas(table_name, column_name, formula)` — stocke les formules SQL par colonne. Préfixée `_` pour être masquée du client.

## Tables principales

| Table | Description | Lignes approx. |
|-------|-------------|----------------|
| stock_it | Stock entrepôt journalier | ~51 |
| suivi_equipe | Productivité équipe | ~37 000 |
| dashdoc_kpi | KPI transports | ~83 |
| recap_bl | Récap bons de livraison | ~26 000 |
| moyenne_conso_l_jour | Conso véhicules | ~235 |
| suivi_carburant_et_peages | Carburant et péages | ~5 000 |
| dashdoc_livraisons_cp | Livraisons par CP | ~2 900 |
| mouvements | Mouvements de stock | ~370 000 |
| geo_codes_postaux | GPS codes postaux | ~370 |

Toutes les colonnes sont TEXT dans les tables brutes. Les vues (préfixées `v_`) convertissent les types.

## Problème principal résolu

Le client utilisait Google Sheets avec des formules RECHERCHEV sur 37 000+ lignes. Trop lent, cellules vides la nuit. La solution : formules SQL sur les colonnes PostgreSQL, calculées instantanément.

```sql
-- Sheets : =SI(A5="";"";SOMME.SI('Suivi Equipe'!G:G; A5; 'Suivi Equipe'!R:R))
-- SQL :
(SELECT SUM(pfn(s.duree_nbr)) FROM suivi_equipe s WHERE s.n_bl_n_palette = recap_bl.n__bl)
```

## Lancer le projet

```bash
# 1. Copier le template d'env et y mettre les vrais mots de passe
cp .env.example .env
# (éditer .env)

# 2. Démarrer
docker compose up --build

# Interface : http://localhost:3000
# API      : http://localhost:8000  (Basic Auth)
# Docs     : http://localhost:8000/docs
```

## Conventions importantes

- Le frontend appelle l'API via `/api/` (proxifié par Nginx) — variable `API` = `'/api'`
- Pas de build step, pas de framework — vanilla JS dans `app.js`
- Données PostgreSQL en TEXT dans les tables brutes — utiliser `pfn()` pour les calculs
- La **première colonne** de chaque table sert de clé primaire pour les UPDATE/DELETE
- Authentification stockée en `sessionStorage` (perdu à la fermeture du navigateur)
- Modifications bufferisées côté client puis envoyées en batch via `PUT /cells/batch` (Ctrl+S ou bouton Sauvegarder)

## Points d'attention

- `docker-compose.yml` expose PostgreSQL sur `127.0.0.1:5433` uniquement (pas LAN)
- `init.sql` n'est exécuté qu'à la première création du volume
- Pour réinitialiser : `docker compose down -v && docker compose up --build`
- En production, pointer `DB_HOST` vers le serveur Windows dans `.env`
- Les formules SQL ont accès à toute la BD via le user `mhp_user` — restreindre l'accès à l'API (Basic Auth + idéalement reverse proxy avec restriction IP)

## Évolutions possibles

- Authentification multi-utilisateurs (table users + JWT)
- Audit log (qui a modifié quoi)
- Export CSV/Excel
- Recherche globale
- Graphiques (Chart.js)
- Optimistic locking (deux users sur la même cellule)
- Rôle PostgreSQL séparé en lecture seule pour les formules
