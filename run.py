from pathlib import Path
import os
from dotenv import load_dotenv
from app import create_app

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

database_path = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "agriparcelles.sqlite")))
if not database_path.is_absolute():
    database_path = ROOT / database_path

app = create_app({
    "DATABASE": str(database_path),
    "SPATIALITE_EXTENSION": os.getenv("SPATIALITE_EXTENSION") or None,
    "EE_PROJECT": os.getenv("EE_PROJECT") or None,
})

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0").strip() == "1"
    app.run(host=host, port=port, debug=debug)
