#!/usr/bin/env python3
"""Use Google's official Google Cloud product icons in the architecture diagram.

1. Download the icon pack from https://cloud.google.com/icons (zip of SVG files) - Google publishes these
   icons for use in architecture diagrams; check its terms of use.
2. Run:  python3 tools/install_gcp_icons.py ~/Downloads/google-cloud-icons.zip
3. Redeploy (./deploy.sh ...). The diagram then shows each product's official icon; products without a
   match keep the built-in icon.

The script copies only the SVGs it can match to products used by Data Cloud Compass into
app/static/icons/ and writes app/static/icons/manifest.json ({product key: "static/icons/<file>.svg"}).
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "static" / "icons"

# product key used by the app -> names to look for in the icon file names (first match wins)
WANT = {
    "bigquery": ["bigquery"], "datastream": ["datastream"], "dataflow": ["dataflow"], "pubsub": ["pubsub", "pub_sub", "pub-sub"],
    "gcs": ["cloud_storage", "cloud-storage", "storage"], "composer": ["composer"], "dataform": ["dataform"],
    "datafusion": ["data_fusion", "data-fusion", "datafusion"], "dataproc": ["dataproc"], "dms": ["database_migration", "database-migration"],
    "storage_transfer": ["transfer_service", "storage_transfer", "storage-transfer"], "transfer_appliance": ["transfer_appliance", "transfer-appliance"],
    "alloydb": ["alloydb"], "cloudsql": ["cloud_sql", "cloud-sql", "cloudsql"], "spanner": ["spanner"], "bigtable": ["bigtable"],
    "firestore": ["firestore"], "memorystore": ["memorystore"], "apigee": ["apigee"], "looker": ["looker"], "looker_studio": ["looker_studio", "looker-studio", "data_studio"],
    "vertex_ai": ["vertex_ai", "vertex-ai", "vertexai"], "gemini": ["gemini"], "dataplex": ["dataplex", "knowledge_catalog"],
    "kms": ["key_management", "kms", "cloud_key"], "sdp": ["sensitive_data", "data_loss_prevention", "dlp"], "vpc_sc": ["vpc_service_controls", "service_controls"],
    "scc": ["security_command_center", "security-command-center"], "assured_workloads": ["assured_workloads", "assured-workloads"],
    "vpn": ["cloud_vpn", "cloud-vpn", "vpn"], "interconnect": ["interconnect"], "cloud_run": ["cloud_run", "cloud-run"], "workflows": ["workflows"],
    "logging": ["cloud_logging", "logging"], "gke": ["kubernetes_engine", "gke"], "managed_kafka": ["managed_kafka", "kafka"],
    "app_integration": ["application_integration", "integration_connectors"], "mde": ["manufacturing_data_engine"],
}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower())


def main(zip_path: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        svgs = [n for n in z.namelist() if n.lower().endswith(".svg") and "__macosx" not in n.lower()]
        manifest = {}
        for key, names in WANT.items():
            # prefer the shortest file name that contains the product name (the plain product icon)
            hits = sorted((n for n in svgs if any(w.replace("-", "_") in norm(Path(n).stem) for w in names)), key=lambda n: (len(Path(n).stem), n))
            if not hits:
                continue
            dest = OUT / f"{key}.svg"
            dest.write_bytes(z.read(hits[0]))
            manifest[key] = f"static/icons/{key}.svg"
            print(f"  {key:18s} <- {hits[0]}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} icons installed in {OUT}. Redeploy to publish them.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
