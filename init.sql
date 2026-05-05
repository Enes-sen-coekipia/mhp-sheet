-- Fonctions utilitaires
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

-- Table de métadonnées formules
CREATE TABLE IF NOT EXISTS _mhp_formulas (
    table_name TEXT,
    column_name TEXT,
    formula TEXT,
    PRIMARY KEY (table_name, column_name)
);

-- ─── Indexes pour accélérer les RECHERCHEV-via-SQL et filtres usuels ───
-- À jouer manuellement sur une BD existante :
--   docker exec -i mhp_postgres psql -U mhp_user -d pilotage_mhp < init.sql
-- (les CREATE INDEX IF NOT EXISTS sont idempotents)
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_n_bl_n_palette ON suivi_equipe(n_bl_n_palette);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_client         ON suivi_equipe(client);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_date           ON suivi_equipe(date);
CREATE INDEX IF NOT EXISTS idx_suivi_equipe_code           ON suivi_equipe(code);

CREATE INDEX IF NOT EXISTS idx_recap_bl_n__bl              ON recap_bl(n__bl);
CREATE INDEX IF NOT EXISTS idx_recap_bl_client             ON recap_bl(client);
CREATE INDEX IF NOT EXISTS idx_recap_bl_date               ON recap_bl(date);

CREATE INDEX IF NOT EXISTS idx_stock_it_date               ON stock_it(date);
CREATE INDEX IF NOT EXISTS idx_dashdoc_kpi_date            ON dashdoc_kpi(date);
CREATE INDEX IF NOT EXISTS idx_moyenne_conso_plaque        ON moyenne_conso_l_jour(plaque);
CREATE INDEX IF NOT EXISTS idx_moyenne_conso_date          ON moyenne_conso_l_jour(date);

-- TABLE STOCK IT
CREATE TABLE IF NOT EXISTS stock_it (
    date TEXT,
    nbr_bl_entree TEXT,
    palettes_entree TEXT,
    pal_livree_sortie TEXT,
    palettes_en_stock TEXT,
    references_en_stock TEXT,
    volume_picking TEXT,
    taux_prepa_homogene TEXT,
    client TEXT,
    fiabilite_de_stock TEXT
);

INSERT INTO stock_it VALUES
('03/12/2025','19','330','407','11707','2812','5025','66','0','1,00%'),
('04/12/2025','16','224','280','11717','2822','3386','55','3','0,97%'),
('05/12/2025','19','233','414','11712','2800','7839','63','4','0,96%'),
('08/12/2025','21','421','297','11832','2820','4704','66','4','0,96%'),
('09/12/2025','16','297','','11777','2814','5164','52','2','0,98%'),
('10/12/2025','14','185','296','11716','2813','4428','63','3','0,97%'),
('11/12/2025','18','360','370','11706','2818','6234','71','4','0,99%'),
('12/12/2025','12','178','281','11603','2806','3891','68','2','0,98%'),
('15/12/2025','20','412','390','11625','2815','7120','72','5','1,00%'),
('16/12/2025','17','310','340','11595','2810','5840','69','3','0,97%');

-- TABLE DASHDOC KPI
CREATE TABLE IF NOT EXISTS dashdoc_kpi (
    date TEXT,
    nb_transports_crees TEXT,
    total_palettes_crees TEXT,
    nb_transports_affretes_crees TEXT
);

INSERT INTO dashdoc_kpi VALUES
('09/12/2025','33','2775','5'),
('10/12/2025','14','294','2'),
('11/12/2025','24','2865','3'),
('12/12/2025','18','1920','1'),
('15/12/2025','28','3100','4'),
('16/12/2025','22','2450','2'),
('17/12/2025','31','3380','6'),
('18/12/2025','19','2100','3');

-- TABLE SUIVI EQUIPE
CREATE TABLE IF NOT EXISTS suivi_equipe (
    code TEXT,
    date TEXT,
    operation TEXT,
    client TEXT,
    duree TEXT,
    n_bl_n_palette TEXT,
    um_consolide TEXT,
    productivite TEXT,
    alerte TEXT,
    duree_nbr TEXT
);

INSERT INTO suivi_equipe VALUES
('MAT','06/01/2025','SORTIE','EUROTAB','00:39:24','winsford 128546','33','7164','Ok','0,027361'),
('ANG','10/01/2025','ENTREE','HELPEVIA','01:12:30','2053842','45','4885','Ok','0,050347'),
('ROU','10/01/2025','SORTIE','BBA Emballages','00:28:15','2053843','28','19321','Ok','0,019618'),
('FRA','11/01/2025','SORTIE','CELNAT','02:15:00','2053844','60','2800','Alerte +2h','0,093750'),
('DEL','12/01/2025','ENTREE','ALIMENTATION SANTE','00:45:00','2053845','22','5800','Ok','0,031250'),
('LLU','13/01/2025','SORTIE','WEISS','01:30:00','2053953','38','3900','Ok','0,062500'),
('PAY','14/01/2025','ENTREE','HELPEVIA','00:55:00','2053973','30','6200','Ok','0,038194'),
('PER','15/01/2025','SORTIE','EUROTAB','03:20:00','2053981','75','2100','Alerte +2h','0,138889');

-- TABLE RECAP BL
CREATE TABLE IF NOT EXISTS recap_bl (
    n__bl TEXT,
    sum_de_um TEXT,
    client TEXT,
    duree TEXT,
    date TEXT,
    preparateur TEXT,
    productivite TEXT
);

INSERT INTO recap_bl VALUES
('9373','3','EIC-ALEMBAL','','','',''),
('9402','8','EIC-ALEMBAL','','','',''),
('2053842','6','BBA Emballages','00:10:08','26/11/2025','Pel',''),
('2053843','3','BBA Emballages','01:37:44','03/01/2025','PER',''),
('2053844','8','BBA Emballages','00:02:04','02/01/2025','PER',''),
('2053845','6','BBA Emballages','00:01:34','06/01/2025','PER',''),
('2053953','6','BBA Emballages','00:03:17','02/01/2025','PER',''),
('2053973','3','BBA Emballages','00:03:58','02/01/2025','PER','');

-- TABLE MOYENNE CONSO
CREATE TABLE IF NOT EXISTS moyenne_conso_l_jour (
    date TEXT,
    plaque TEXT,
    km TEXT,
    litres TEXT,
    conso_l_100_km TEXT
);

INSERT INTO moyenne_conso_l_jour VALUES
('05/01/2026','EG-598-FF','140','428','3057142857'),
('05/01/2026','EV-302-RC','199','563','2829145729'),
('05/01/2026','FM-080-EC','226','53','2345132743'),
('06/01/2026','EG-598-FF','180','520','2888888888'),
('06/01/2026','EV-302-RC','210','600','2857142857');
