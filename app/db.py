
import os
import sqlite3
from pathlib import Path


class SpatialiteUnavailable(RuntimeError):
    pass


# Conserver les répertoires DLL enregistrés pendant toute la durée
# du programme. Nécessaire sous Windows avec Python 3.8+.
_DLL_DIRECTORY_HANDLES = {}


def _extension_candidates(configured=None):
    value = configured or os.environ.get("SPATIALITE_EXTENSION")

    if value:
        yield value

    for name in (
        "mod_spatialite",
        "mod_spatialite.dll",
        "mod_spatialite.so",
        "mod_spatialite.dylib",
    ):
        yield name

    if os.name == "nt":
        for base in (
            os.environ.get("OSGEO4W_ROOT"),
            r"C:\OSGeo4W",
            r"C:\OSGeo4W64",
        ):
            if base:
                yield str(Path(base) / "bin" / "mod_spatialite.dll")


def connect_database(path, extension=None):

    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    configured_extension = (
        extension or os.environ.get("SPATIALITE_EXTENSION")
    )

    # CORRECTION WINDOWS :
    # Ajouter le dossier contenant mod_spatialite.dll
    # au chemin de recherche des bibliothèques secondaires.
    if os.name == "nt" and configured_extension:

        dll_path = Path(configured_extension).expanduser()

        if dll_path.suffix.lower() == ".dll":

            dll_directory = str(dll_path.resolve().parent)

            if (
                Path(dll_directory).is_dir()
                and dll_directory not in _DLL_DIRECTORY_HANDLES
            ):
                _DLL_DIRECTORY_HANDLES[dll_directory] = (
                    os.add_dll_directory(dll_directory)
                )

    connection = sqlite3.connect(
        str(db_path),
        timeout=15
    )

    connection.row_factory = sqlite3.Row

    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")

    try:
        connection.enable_load_extension(True)

        errors = []
        loaded = False

        for candidate in _extension_candidates(configured_extension):

            try:
                connection.load_extension(candidate)
                loaded = True
                break

            except sqlite3.Error as exc:
                errors.append(f"{candidate}: {exc}")

        if not loaded:

            details = " | ".join(errors)

            raise SpatialiteUnavailable(
                "Impossible de charger SpatiaLite. "
                "Vérifiez mod_spatialite.dll et ses dépendances. "
                + details
            )

    except Exception:
        connection.close()
        raise

    finally:
        try:
            connection.enable_load_extension(False)
        except sqlite3.Error:
            pass

    return connection


def initialize_database(path, extension=None):
    """Crée les métadonnées SpatiaLite et la table parcelles."""

    conn = connect_database(path, extension)

    try:

        existing = conn.execute(
            """
            SELECT 1
            FROM sqlite_master
            WHERE type='table' AND name='parcelles'
            """
        ).fetchone()

        if existing:

            version = conn.execute(
                "SELECT spatialite_version()"
            ).fetchone()[0]

            return version, False

        conn.execute("SELECT InitSpatialMetadata(1)")

        conn.execute(
            """
            CREATE TABLE parcelles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                num_parcelle TEXT NOT NULL UNIQUE,
                agriculteur TEXT NOT NULL,
                culture TEXT NOT NULL,
                superficie_ha REAL,
                production_t REAL CHECK (production_t >= 0),
                date_saisie TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        result = conn.execute(
            """
            SELECT AddGeometryColumn(
                'parcelles',
                'geom',
                4326,
                'POLYGON',
                'XY',
                1
            )
            """
        ).fetchone()

        if result is None or result[0] != 1:
            raise RuntimeError(
                "AddGeometryColumn n'a pas confirmé l'ajout de geom."
            )

        index_result = conn.execute(
            """
            SELECT CreateSpatialIndex('parcelles', 'geom')
            """
        ).fetchone()

        if index_result is None or index_result[0] != 1:
            raise RuntimeError(
                "CreateSpatialIndex n'a pas confirmé la création de l'index."
            )

        conn.commit()

        version = conn.execute(
            "SELECT spatialite_version()"
        ).fetchone()[0]

        return version, True

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()
