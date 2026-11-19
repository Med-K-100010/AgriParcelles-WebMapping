from pathlib import Path
import argparse
import os
import sys
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from app.db import initialize_database, connect_database


def main():
    parser = argparse.ArgumentParser(description="Initialise la base SQLite + SpatiaLite d'AgriParcelles.")
    parser.add_argument("--database", default=os.getenv("DATABASE_PATH", str(ROOT / "data" / "agriparcelles.sqlite")))
    parser.add_argument("--extension", default=os.getenv("SPATIALITE_EXTENSION") or None)
    args = parser.parse_args()
    path = Path(args.database)
    if not path.is_absolute():
        path = ROOT / path
    version, created = initialize_database(path, args.extension)
    conn = connect_database(path, args.extension)
    try:
        count = conn.execute("SELECT COUNT(*) FROM parcelles").fetchone()[0]
        geometry = conn.execute("SELECT geometry_type, coord_dimension, srid, spatial_index_enabled FROM geometry_columns WHERE f_table_name='parcelles' AND f_geometry_column='geom'").fetchone()
        probe = '{"type":"Polygon","coordinates":[[[-9.21,30.40],[-9.20,30.40],[-9.20,30.41],[-9.21,30.41],[-9.21,30.40]]]}'
        area_probe = conn.execute(
            "SELECT ST_Area(SetSRID(GeomFromGeoJSON(?),4326),1)", (probe,)
        ).fetchone()[0]
        if area_probe is None or area_probe <= 0:
            raise RuntimeError("ST_Area(geom, 1) n'est pas disponible. Installez un build SpatiaLite avec support LWGEOM.")
    finally:
        conn.close()
    action = "créée" if created else "déjà présente"
    print(f"Base : {path}")
    print(f"SpatiaLite : {version}")
    print(f"Table parcelles : {action}")
    print(f"Géométrie : {tuple(geometry) if geometry else 'métadonnées introuvables'}")
    print(f"Parcelles enregistrées : {count}")
    print("Initialisation terminée. La collecte des 15 parcelles réelles reste à effectuer dans l'application.")


if __name__ == "__main__":
    main()
