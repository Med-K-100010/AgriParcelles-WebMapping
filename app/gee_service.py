import logging
import threading
from datetime import date, timedelta

try:
    import ee
except ImportError:  # permet d'afficher un message utile si les dépendances ne sont pas installées
    ee = None

logger = logging.getLogger(__name__)
_init_lock = threading.Lock()
_initialized_project = None


class EarthEngineNotConfigured(RuntimeError):
    pass


class EarthEngineRequestError(RuntimeError):
    def __init__(self, message, no_usable_data=False):
        super().__init__(message)
        self.no_usable_data = no_usable_data


def _ensure_ee(project):
    global _initialized_project
    if ee is None:
        raise EarthEngineNotConfigured("Le paquet earthengine-api n'est pas installé. Exécutez pip install -r requirements.txt.")
    if not project:
        raise EarthEngineNotConfigured("Earth Engine n'est pas configuré : renseignez EE_PROJECT dans le fichier .env.")
    with _init_lock:
        if _initialized_project == project:
            return
        try:
            ee.Initialize(project=project)
        except Exception as exc:
            logger.warning("Initialisation Earth Engine refusée ou impossible: %s", exc)
            raise EarthEngineNotConfigured(
                "Authentification Earth Engine absente ou invalide. Exécutez earthengine authenticate avec le compte autorisé, puis vérifiez EE_PROJECT."
            ) from exc
        _initialized_project = project


def _interpret(value):
    if value < 0.2:
        return "Sol nu ou végétation très faible"
    if value < 0.4:
        return "Végétation faible"
    if value <= 0.6:
        return "Végétation modérée"
    return "Végétation dense"


def calculate_parcel_ndvi(geometry, num_parcelle, start_date, end_date_inclusive, project):
    _ensure_ee(project)
    # Earth Engine filterDate utilise une borne de fin exclusive : ajouter un jour
    # pour inclure la date de fin choisie dans le formulaire.
    end_exclusive = (date.fromisoformat(end_date_inclusive) + timedelta(days=1)).isoformat()
    try:
        parcel = ee.Geometry(geometry)
        source = (
            ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(parcel)
            .filterDate(start_date, end_exclusive)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
        )
        count = int(source.size().getInfo())
        if count == 0:
            raise EarthEngineRequestError(
                "Aucune image Sentinel-2 ne répond aux filtres pour cette période. Élargissez la période et réessayez.",
                no_usable_data=True,
            )

        def mask_scl(image):
            scl = image.select("SCL")
            keep = scl.eq(4).Or(scl.eq(5))
            return image.updateMask(keep)

        def add_ndvi(image):
            ndvi = image.normalizedDifference(["B8", "B4"]).rename("NDVI")
            return ndvi.copyProperties(image, ["system:time_start"])

        ndvi_mean_image = source.map(mask_scl).map(add_ndvi).mean()
        stats = ndvi_mean_image.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=parcel,
            scale=10,
            maxPixels=1_000_000_000,
        )
        value = stats.get("NDVI").getInfo()
        if value is None:
            raise EarthEngineRequestError(
                "Des scènes existent, mais aucun pixel NDVI exploitable ne subsiste dans la parcelle après le masque SCL (classes 4 et 5).",
                no_usable_data=True,
            )
        value = float(value)
        if not (-1.0 <= value <= 1.0):
            raise EarthEngineRequestError("La valeur NDVI retournée est hors de l'intervalle attendu [-1, 1].")
        return {
            "num_parcelle": num_parcelle,
            "debut": start_date,
            "fin": end_date_inclusive,
            "ndvi_moyen": round(value, 3),
            "nb_images": count,
            "interpretation": _interpret(value),
        }
    except EarthEngineRequestError:
        raise
    except Exception as exc:
        logger.exception("Erreur de calcul Earth Engine")
        raise EarthEngineRequestError(
            "Earth Engine n'a pas pu terminer le calcul. Vérifiez le projet Cloud, les droits d'accès et la disponibilité du service."
        ) from exc
