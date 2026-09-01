"""Push local profiles/datasets/raw/uploads into the configured durable store."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .data_store import create_persistence, push_blob_tree, push_json_tree
from .profile_store import load_dotenv_file


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def sync_all(
    *,
    profiles_dir: Path = PROJECT_ROOT / "config" / "profiles",
    datasets_dir: Path = PROJECT_ROOT / "data" / "processed",
    data_dir: Path = PROJECT_ROOT / "data",
) -> dict[str, list[str]]:
    """Upload everything currently on disk into profiles/datasets/blobs stores."""
    bundle = create_persistence(
        profiles_dir=profiles_dir,
        datasets_dir=datasets_dir,
        blob_root=data_dir,
    )
    profiles: list[str] = []
    if profiles_dir.exists():
        for path in sorted(profiles_dir.glob("*.json")):
            if not path.is_file():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                continue
            profile_id = str(payload.get("profile_id") or path.stem)
            bundle.profiles.put(profile_id, payload)
            profiles.append(profile_id)

    datasets = push_json_tree(datasets_dir, bundle.datasets, relative_root=datasets_dir)
    raw = push_blob_tree(data_dir / "raw", bundle.blobs, prefix="raw")
    uploads = push_blob_tree(data_dir / "uploads", bundle.blobs, prefix="uploads")
    processed_extra = push_blob_tree(datasets_dir, bundle.blobs, prefix="processed")
    return {
        "mode": [bundle.mode],
        "profiles": profiles,
        "datasets": datasets,
        "raw": raw,
        "uploads": uploads,
        "processed_blobs": processed_extra,
    }


def main(argv: list[str] | None = None) -> None:
    load_dotenv_file(PROJECT_ROOT / ".env")
    parser = argparse.ArgumentParser(description="Sync local fantasy data into Supabase/local stores.")
    parser.add_argument("--profiles-dir", type=Path, default=PROJECT_ROOT / "config" / "profiles")
    parser.add_argument("--datasets-dir", type=Path, default=PROJECT_ROOT / "data" / "processed")
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / "data")
    args = parser.parse_args(argv)
    result = sync_all(profiles_dir=args.profiles_dir, datasets_dir=args.datasets_dir, data_dir=args.data_dir)
    print(json.dumps({key: (value if key == "mode" else len(value)) for key, value in result.items()}, indent=2))
    print(json.dumps(result, indent=2)[:2000])


if __name__ == "__main__":
    main()
