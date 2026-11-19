-- AgriParcelles : schéma imposé par le cahier des charges.
-- Exécuter via scripts/init_db.py après chargement de mod_spatialite.
-- Ne pas renommer les colonnes et ne pas ajouter de table métier.

CREATE TABLE parcelles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    num_parcelle   TEXT NOT NULL UNIQUE,
    agriculteur    TEXT NOT NULL,
    culture        TEXT NOT NULL,
    superficie_ha REAL,
    production_t   REAL CHECK (production_t >= 0),
    date_saisie    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Ajouté par init_db.py après InitSpatialMetadata(1) :
-- SELECT AddGeometryColumn('parcelles', 'geom', 4326, 'POLYGON', 'XY', 1);
-- SELECT CreateSpatialIndex('parcelles', 'geom');
