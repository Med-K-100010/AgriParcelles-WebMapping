import json
import math
from datetime import date

from flask import Blueprint, current_app, g, jsonify, request

from .db import SpatialiteUnavailable, connect_database
from .gee_service import EarthEngineNotConfigured, EarthEngineRequestError, calculate_parcel_ndvi

api = Blueprint("api", __name__, url_prefix="/api")
CULTURES = {
    "Blé dur", "Blé tendre", "Orge", "Maïs", "Betterave sucrière", "Olivier",
    "Agrumes", "Maraîchage", "Luzerne", "Jachère", "Autre"
}


def get_db():
    if "db" not in g:
        g.db = connect_database(
            current_app.config["DATABASE"],
            current_app.config.get("SPATIALITE_EXTENSION"),
        )
    return g.db


@api.teardown_app_request
def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def error(message, status):
    return jsonify({"error": message}), status


def _as_geometry(payload):
    if not isinstance(payload, dict):
        raise ValueError("La géométrie GeoJSON est absente ou invalide.")
    if payload.get("type") == "Feature":
        payload = payload.get("geometry")
    if not isinstance(payload, dict) or payload.get("type") != "Polygon":
        raise ValueError("Seule une géométrie GeoJSON de type Polygon est acceptée.")
    if not isinstance(payload.get("coordinates"), list) or not payload["coordinates"]:
        raise ValueError("Le polygone ne contient aucun anneau de coordonnées.")
    return payload


def _measure_geometry(conn, geometry):
    geojson_text = json.dumps(geometry, ensure_ascii=False, separators=(",", ":"))
    try:
        row = conn.execute(
            """SELECT GeometryType(g.geom) AS geom_type,
                      ST_IsValid(g.geom) AS is_valid,
                      ST_IsValidReason(g.geom) AS validity_reason,
                      ST_Area(g.geom, 1) AS area_m2,
                      ST_SRID(g.geom) AS srid
               FROM (SELECT SetSRID(GeomFromGeoJSON(?), 4326) AS geom) AS g""",
            (geojson_text,),
        ).fetchone()
    except Exception as exc:
        raise ValueError("GeoJSON non convertible par SpatiaLite : vérifiez la structure du polygone.") from exc
    if row is None or row["geom_type"] is None:
        raise ValueError("La géométrie n'a pas pu être convertie.")
    if str(row["geom_type"]).upper() != "POLYGON":
        raise ValueError("La géométrie doit être un polygone simple.")
    if row["srid"] != 4326:
        raise ValueError("La géométrie doit être en WGS84 (EPSG:4326).")
    if row["is_valid"] != 1:
        reason = row["validity_reason"] or "géométrie topologiquement invalide"
        raise ValueError(f"Polygone invalide : {reason}.")
    area_m2 = row["area_m2"]
    if area_m2 is None or not math.isfinite(float(area_m2)) or float(area_m2) <= 0:
        raise ValueError("La superficie ellipsoïdale ne peut pas être calculée.")
    return geojson_text, float(area_m2) / 10000.0


def _row_to_feature(row):
    geometry = json.loads(row["geojson"])
    properties = {
        "id": row["id"],
        "num_parcelle": row["num_parcelle"],
        "agriculteur": row["agriculteur"],
        "culture": row["culture"],
        "superficie_ha": row["superficie_ha"],
        "production_t": row["production_t"],
        "date_saisie": row["date_saisie"],
    }
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def _select_parcelles(conn, where="", params=()):
    return conn.execute(
        f"""SELECT id, num_parcelle, agriculteur, culture,
                   superficie_ha, production_t, date_saisie,
                   AsGeoJSON(geom, 7, 0) AS geojson
            FROM parcelles {where}
            ORDER BY num_parcelle""",
        params,
    ).fetchall()


@api.get("/health")
def health():
    try:
        conn = get_db()
        version = conn.execute("SELECT spatialite_version()").fetchone()[0]
        table = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parcelles'").fetchone()
        geom = conn.execute("SELECT 1 FROM geometry_columns WHERE f_table_name='parcelles' AND f_geometry_column='geom' AND srid=4326").fetchone()
        if not table or not geom:
            return error("La base existe mais son schéma spatial n'est pas initialisé. Exécutez python scripts/init_db.py.", 503)
        return jsonify({"status": "ok", "spatialite_version": version})
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Échec du contrôle de santé")
        return error("Base spatiale indisponible. Vérifiez la configuration SpatiaLite.", 503)


@api.get("/parcelles")
def list_parcelles():
    try:
        rows = _select_parcelles(get_db())
        features = [_row_to_feature(row) for row in rows]
        return jsonify({"type": "FeatureCollection", "features": features, "count": len(features)})
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Lecture de la couche parcelles impossible")
        return error("Impossible de lire la couche parcelles.", 500)


@api.post("/geometry/area")
def geometry_area():
    payload = request.get_json(silent=True) or {}
    try:
        geometry = _as_geometry(payload.get("geometry"))
        _geojson_text, area_ha = _measure_geometry(get_db(), geometry)
        return jsonify({"superficie_ha": round(area_ha, 6), "unite": "ha", "methode": "ST_Area(geom, 1) / 10000"})
    except ValueError as exc:
        return error(str(exc), 422)
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Calcul de superficie impossible")
        return error("Le calcul de superficie a échoué. Vérifiez l'extension SpatiaLite et son support ellipsoïdal.", 500)


@api.post("/parcelles")
def create_parcelle():
    payload = request.get_json(silent=True) or {}
    num = str(payload.get("num_parcelle", "")).strip()
    agriculteur = str(payload.get("agriculteur", "")).strip()
    culture = str(payload.get("culture", "")).strip()

    if not num:
        return error("Le numéro de parcelle est obligatoire.", 422)
    if len(num) > 80:
        return error("Le numéro de parcelle ne peut pas dépasser 80 caractères.", 422)
    if not agriculteur:
        return error("Le nom de l'agriculteur est obligatoire.", 422)
    if len(agriculteur) > 150:
        return error("Le nom de l'agriculteur ne peut pas dépasser 150 caractères.", 422)
    if culture not in CULTURES:
        return error("La culture choisie ne figure pas dans la liste autorisée.", 422)
    try:
        production = float(payload.get("production_t"))
    except (TypeError, ValueError):
        return error("La production doit être un nombre positif ou nul.", 422)
    if not math.isfinite(production) or production < 0:
        return error("La production doit être un nombre positif ou nul.", 422)
    try:
        geometry = _as_geometry(payload.get("geometry"))
        geojson_text, area_ha = _measure_geometry(get_db(), geometry)
        conn = get_db()
        if conn.execute("SELECT 1 FROM parcelles WHERE num_parcelle = ?", (num,)).fetchone():
            return error(f"Le numéro de parcelle « {num} » existe déjà. Modifiez le numéro ou annulez le dessin.", 409)
        try:
            cursor = conn.execute(
                """INSERT INTO parcelles
                   (num_parcelle, agriculteur, culture, superficie_ha, production_t, geom)
                   VALUES (?, ?, ?, ?, ?, SetSRID(GeomFromGeoJSON(?), 4326))""",
                (num, agriculteur, culture, area_ha, production, geojson_text),
            )
            conn.commit()
        except Exception as exc:
            conn.rollback()
            if "UNIQUE constraint failed" in str(exc):
                return error(f"Le numéro de parcelle « {num} » existe déjà.", 409)
            raise
        row = conn.execute(
            """SELECT id, num_parcelle, agriculteur, culture, superficie_ha,
                      production_t, date_saisie, AsGeoJSON(geom, 7, 0) AS geojson
               FROM parcelles WHERE id = ?""",
            (cursor.lastrowid,),
        ).fetchone()
        return jsonify(_row_to_feature(row)), 201
    except ValueError as exc:
        return error(str(exc), 422)
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Insertion de parcelle impossible")
        return error("L'enregistrement a échoué. Vérifiez la base spatiale et les attributs saisis.", 500)


@api.delete("/parcelles/<int:parcel_id>")
def delete_parcelle(parcel_id):
    """Supprime définitivement une parcelle identifiée par sa clé primaire."""
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT num_parcelle FROM parcelles WHERE id = ?",
            (parcel_id,),
        ).fetchone()
        if row is None:
            return error("Cette parcelle n'existe pas ou a déjà été supprimée.", 404)

        number = row["num_parcelle"]
        try:
            conn.execute("DELETE FROM parcelles WHERE id = ?", (parcel_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        return jsonify({
            "deleted": True,
            "id": parcel_id,
            "num_parcelle": number,
            "message": f"La parcelle {number} a été supprimée.",
        })
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Suppression de parcelle impossible (id=%s)", parcel_id)
        return error("La suppression a échoué. La base de données n'a pas été modifiée.", 500)


def _parse_date(value, label):
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        raise ValueError(f"La date {label} est invalide. Utilisez le format AAAA-MM-JJ.")


@api.post("/ndvi")
def ndvi_for_parcel():
    payload = request.get_json(silent=True) or {}
    num = str(payload.get("num_parcelle", "")).strip()
    if not num:
        return error("Le numéro de parcelle est obligatoire.", 422)
    try:
        start = _parse_date(payload.get("debut"), "de début")
        end = _parse_date(payload.get("fin"), "de fin")
        today = date.today()  # date locale de la machine qui exécute le serveur
        if start < date(2019, 1, 1):
            return error("La date de début doit être égale ou postérieure au 01/01/2019.", 422)
        if end > today:
            return error("La date de fin ne peut pas dépasser la date du jour.", 422)
        if start >= end:
            return error("La date de début doit être antérieure à la date de fin.", 422)
        if (end - start).days < 10:
            return error("L'intervalle doit couvrir au moins 10 jours.", 422)
        row = get_db().execute(
            "SELECT AsGeoJSON(geom, 8, 0) AS geojson FROM parcelles WHERE num_parcelle = ?",
            (num,),
        ).fetchone()
        if row is None:
            return error("Cette parcelle n'existe pas dans la base de données.", 404)
        geometry = json.loads(row["geojson"])
        result = calculate_parcel_ndvi(
            geometry=geometry,
            num_parcelle=num,
            start_date=start.isoformat(),
            end_date_inclusive=end.isoformat(),
            project=current_app.config.get("EE_PROJECT"),
        )
        return jsonify(result)
    except ValueError as exc:
        return error(str(exc), 422)
    except EarthEngineNotConfigured as exc:
        return error(str(exc), 503)
    except EarthEngineRequestError as exc:
        status = 422 if exc.no_usable_data else 502
        return error(str(exc), status)
    except SpatialiteUnavailable as exc:
        return error(str(exc), 503)
    except Exception:
        current_app.logger.exception("Calcul NDVI impossible")
        return error("Le calcul NDVI a échoué. Vérifiez la connexion et la configuration Earth Engine.", 502)
