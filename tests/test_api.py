import json
import os
import tempfile
import unittest
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from app import create_app
from app.db import initialize_database

ROOT = Path(__file__).resolve().parents[1]
TEST_EXTENSION = os.environ.get("SPATIALITE_EXTENSION", "mod_spatialite")


class AgriParcellesApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "test.sqlite")
        initialize_database(self.db_path, TEST_EXTENSION)
        self.app = create_app({
            "TESTING": True,
            "DATABASE": self.db_path,
            "SPATIALITE_EXTENSION": TEST_EXTENSION,
            "EE_PROJECT": None,
        })
        self.client = self.app.test_client()
        self.geometry = {
            "type": "Polygon",
            "coordinates": [[
                [-9.2100, 30.4000], [-9.2090, 30.4000],
                [-9.2090, 30.4010], [-9.2100, 30.4010], [-9.2100, 30.4000]
            ]]
        }

    def tearDown(self):
        self.tmp.cleanup()

    def payload(self, number="OT-TEST-001"):
        return {
            "num_parcelle": number,
            "agriculteur": "Agriculteur test",
            "culture": "Olivier",
            "production_t": 3.5,
            "geometry": self.geometry,
        }

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertIn("spatialite_version", response.get_json())

    def test_area_is_positive(self):
        response = self.client.post("/api/geometry/area", json={"geometry": self.geometry})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertGreater(response.get_json()["superficie_ha"], 0)

    def test_create_and_list_parcelle(self):
        response = self.client.post("/api/parcelles", json=self.payload())
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertGreater(response.get_json()["properties"]["superficie_ha"], 0)
        listed = self.client.get("/api/parcelles").get_json()
        self.assertEqual(listed["count"], 1)
        self.assertEqual(listed["features"][0]["properties"]["num_parcelle"], "OT-TEST-001")

    def test_delete_parcelle_removes_only_requested_record(self):
        first = self.client.post("/api/parcelles", json=self.payload("OT-DELETE-001"))
        second = self.client.post("/api/parcelles", json=self.payload("OT-KEEP-002"))
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)

        first_id = first.get_json()["properties"]["id"]
        response = self.client.delete(f"/api/parcelles/{first_id}")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()["deleted"])
        self.assertEqual(response.get_json()["num_parcelle"], "OT-DELETE-001")

        listed = self.client.get("/api/parcelles").get_json()
        numbers = [item["properties"]["num_parcelle"] for item in listed["features"]]
        self.assertEqual(listed["count"], 1)
        self.assertEqual(numbers, ["OT-KEEP-002"])

    def test_delete_missing_parcelle_returns_404(self):
        response = self.client.delete("/api/parcelles/999999")
        self.assertEqual(response.status_code, 404)

    def test_duplicate_returns_409(self):
        self.client.post("/api/parcelles", json=self.payload())
        response = self.client.post("/api/parcelles", json=self.payload())
        self.assertEqual(response.status_code, 409)

    def test_negative_production_rejected(self):
        response = self.client.post("/api/parcelles", json=self.payload())
        self.assertEqual(response.status_code, 201)
        bad = self.payload("OT-TEST-002")
        bad["production_t"] = -1
        response = self.client.post("/api/parcelles", json=bad)
        self.assertEqual(response.status_code, 422)

    def test_invalid_self_intersection_rejected(self):
        bad = {
            "type": "Polygon",
            "coordinates": [[[-9.21,30.40],[-9.20,30.41],[-9.20,30.40],[-9.21,30.41],[-9.21,30.40]]]
        }
        response = self.client.post("/api/geometry/area", json={"geometry": bad})
        self.assertEqual(response.status_code, 422)

    def test_ndvi_date_minimum_interval(self):
        response = self.client.post("/api/ndvi", json={
            "num_parcelle": "OT-X", "debut": "2026-10-01", "fin": "2026-10-05"
        })
        self.assertEqual(response.status_code, 422)
        self.assertIn("10 jours", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
