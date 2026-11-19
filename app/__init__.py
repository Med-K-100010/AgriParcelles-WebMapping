from pathlib import Path
from flask import Flask, send_from_directory


def create_app(test_config=None):
    project_root = Path(__file__).resolve().parents[1]
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config.from_mapping(
        DATABASE=str(project_root / "data" / "agriparcelles.sqlite"),
        SPATIALITE_EXTENSION=None,
        EE_PROJECT=None,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)

    from .routes import api
    app.register_blueprint(api)

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/ndvi")
    def ndvi_page():
        return send_from_directory(app.static_folder, "ndvi.html")

    return app
