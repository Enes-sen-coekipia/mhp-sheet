# Templates Apps Script — push vers MHP DataSheet

Ces fichiers remplacent les scripts existants qui écrivaient dans Google Sheets.
Ils gardent la même logique métier (Gmail, Drive, APIs Dashdoc/Astrata, conversions XLSX)
mais envoient les données dans **MHP DataSheet** (PostgreSQL) au lieu de Sheets.

## Installation

1. Ouvrir le projet Apps Script existant (https://script.google.com/...)
2. Pour chaque script à migrer :
   - Coller la version mise à jour ci-dessous (remplace l'ancienne fonction)
   - **NE PAS supprimer** les triggers Apps Script existants (cron, on edit) — ils continuent de tourner
3. Ajouter **une seule fois** le fichier `_helper.gs` (constantes partagées + fonction `mhpPost`)
4. Dans `_helper.gs`, mettre à jour :
   - `MHP_API` : URL de l'app (`http://192.168.1.7:8081/api` en prod, `http://localhost:3000/api` en dev)
   - `MHP_TOKEN` : token configuré côté serveur dans `.env` (variable `INGEST_API_TOKEN`)

## Modes d'écriture supportés

| Mode | Quand l'utiliser | Body |
|------|------------------|------|
| **append** | Ajouter des lignes (sans contrôle de doublon) | `{rows:[...], mode:"append"}` |
| **upsert** | Mettre à jour si la clé existe, sinon insérer | `{rows:[...], mode:"upsert", primary_keys:["col1","col2"]}` |
| **replace_all** | Vider la table puis tout réinsérer | `{rows:[...], mode:"replace_all"}` |
| **replace_all** (partiel) | Vider une période puis réinsérer | `{rows:[...], mode:"replace_all", truncate_where:"date >= '2025-09-01'"}` |

## Fichiers fournis

| Template | Remplace | Mode | Table cible |
|----------|----------|------|-------------|
| `_helper.gs` | (nouveau) | — | — |
| `stock_it.gs` | `Stock_It.gs` (importStockItReport) | append | `stock_it` |
| `stock_it_preparateur.gs` | `Stock It preparateur.gs` (importStockitPreparateur) | append | `suivi_equipe` |
| `dashdoc_kpi.gs` | `DashdocKPI.gs` (importDashdocKPI) | upsert by date | `dashdoc_kpi` |
| `dashdoc_cp.gs` | `Dashdoc CP v2.gs` (importDashdocLivraisonsCP) | upsert by 3 colonnes | `dashdoc_livraisons_cp` |
| `astrata.gs` | `Astrata.gs` (recupererVehiculesCompteurs) | append + dédoublonnage | `vehicules_compteurs` |
| `leclerc.gs` | `Leclerc.gs` (importLeclercCSV) | upsert by transaction_id | `suivi_carburant_et_peages` |
| `shiptify_relay.gs` | `Shiptify.gs` (doPost webhook) | webhook → MHP | `_mhp_webhooks` |

## Tester un script avant production

1. Modifier `MHP_API` dans `_helper.gs` pour pointer sur ton serveur dev (`http://localhost:3000/api`)
2. Lancer la fonction manuellement dans Apps Script (bouton ▶)
3. Vérifier dans l'app MHP DataSheet que les données sont arrivées dans la table cible

## Désactiver l'ancien comportement (optionnel)

Si tu veux que le script écrive **uniquement** dans MHP DataSheet (et plus dans Sheets) :
commenter ou supprimer les lignes `sheet.getRange(...).setValues(...)` dans le script source.

Tant que les deux destinations sont actives, tu peux comparer Sheets ↔ MHP DataSheet pour valider la migration.

## Sécurité du token

Le `MHP_TOKEN` autorise toute écriture sur la BD. Le partager uniquement entre :
- L'admin Apps Script (toi)
- Le serveur MHP DataSheet (`.env` côté Windows)

Si compromis : régénérer le token dans `.env` côté serveur, redémarrer le backend, mettre à jour `_helper.gs`. Tous les anciens scripts n'auront plus accès jusqu'à mise à jour.
