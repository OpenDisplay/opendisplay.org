#!/usr/bin/env python3
"""Validate simple-config presets and enforce stable id ↔ index mappings.

String ids are used in toolbox share URLs (?driver=&display=&power=).
Numeric indexes are written into device manufacturer data as
simple_config_{driver,display,power}_index (1-based; 0 = unset).

Neither may be reassigned once published. New presets must append a new id
with a new unused index and update simple-config-id-registry.json in the
same change.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

SECTIONS = ("driverBoards", "displays", "powerOptions")
SECTION_LABEL = {
    "driverBoards": "board",
    "displays": "display",
    "powerOptions": "battery/power",
}

REQUIRED: dict[str, tuple[str, ...]] = {
    "driverBoards": (
        "id",
        "name",
        "index",
        "connectorPins",
        "systemConfig",
        "manufacturerData",
        "installConfig",
    ),
    "displays": (
        "id",
        "name",
        "index",
        "connectorPins",
        "panelIcType",
        "config",
    ),
    "powerOptions": ("id", "name", "index", "powerOption"),
}

ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TOOLBOX_URL_PREFIXES = (
    "https://opendisplay.org/firmware/toolbox/",
    "http://opendisplay.org/firmware/toolbox/",
)


def resolve_toolbox_asset(toolbox_dir: Path, ref: str) -> Path | None:
    """Map a relative path or opendisplay.org toolbox URL to a local file path.

    Returns None when the ref is an external URL we cannot verify locally.
    """
    if ref.startswith(TOOLBOX_URL_PREFIXES):
        for prefix in TOOLBOX_URL_PREFIXES:
            if ref.startswith(prefix):
                return toolbox_dir / ref[len(prefix) :]
    if ref.startswith(("http://", "https://")):
        return None
    return toolbox_dir / ref


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def is_positive_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 1
    if isinstance(value, str) and value.strip():
        try:
            return int(value, 0) >= 1
        except ValueError:
            return False
    return False


def as_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    return int(str(value).strip(), 0)


def validate_structure(presets: dict[str, Any], toolbox_dir: Path) -> list[str]:
    errors: list[str] = []

    for section in SECTIONS:
        if section not in presets:
            errors.append(f"presets missing top-level key '{section}'")
            continue
        if not isinstance(presets[section], list):
            errors.append(f"presets['{section}'] must be a list")
            continue

        seen_ids: dict[str, int] = {}
        index_owners: dict[int, list[str]] = defaultdict(list)

        for i, item in enumerate(presets[section]):
            label = f"{section}[{i}]"
            if not isinstance(item, dict):
                errors.append(f"{label}: expected object")
                continue

            for field in REQUIRED[section]:
                if field not in item:
                    errors.append(f"{label}: missing required field '{field}'")

            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id:
                errors.append(f"{label}: 'id' must be a non-empty string")
                continue
            if not ID_RE.match(item_id):
                errors.append(
                    f"{label} id={item_id!r}: id must be lowercase kebab-case "
                    f"(a-z, 0-9, hyphens)"
                )
            if item_id in seen_ids:
                errors.append(
                    f"{section}: duplicate id {item_id!r} "
                    f"(entries {seen_ids[item_id]} and {i})"
                )
            else:
                seen_ids[item_id] = i

            if "index" in item:
                if not is_positive_int(item["index"]):
                    errors.append(
                        f"{section} id={item_id!r}: 'index' must be an integer >= 1 "
                        f"(got {item['index']!r})"
                    )
                else:
                    index_owners[as_int(item["index"])].append(item_id)

            pins = item.get("connectorPins")
            if pins is not None:
                if not isinstance(pins, list) or not pins:
                    errors.append(
                        f"{section} id={item_id!r}: connectorPins must be a non-empty list"
                    )
                elif not all(isinstance(p, int) and not isinstance(p, bool) for p in pins):
                    errors.append(
                        f"{section} id={item_id!r}: connectorPins must be integers"
                    )

            if section == "displays":
                cfg = item.get("config")
                if isinstance(cfg, dict):
                    for dim in ("pixel_width", "pixel_height"):
                        if dim not in cfg:
                            errors.append(
                                f"displays id={item_id!r}: config missing '{dim}'"
                            )

            if section == "powerOptions":
                power = item.get("powerOption")
                if isinstance(power, dict) and "power_mode" not in power:
                    errors.append(
                        f"powerOptions id={item_id!r}: powerOption missing 'power_mode'"
                    )

            if section == "driverBoards":
                install = item.get("installConfig")
                if isinstance(install, dict):
                    if "type" not in install:
                        errors.append(
                            f"driverBoards id={item_id!r}: installConfig missing 'type'"
                        )
                    for key in ("downloadFile", "manifest"):
                        rel = install.get(key)
                        if not isinstance(rel, str) or not rel:
                            continue
                        local = resolve_toolbox_asset(toolbox_dir, rel)
                        if local is None:
                            continue
                        if not local.is_file():
                            errors.append(
                                f"driverBoards id={item_id!r}: "
                                f"installConfig.{key} missing locally: {rel}"
                            )

        for index, owners in sorted(index_owners.items()):
            if len(owners) > 1:
                # Collected separately so callers can treat legacy collisions as
                # warnings while still blocking new ones via the registry.
                errors.append(
                    f"{section}: index {index} is used by multiple ids: "
                    + ", ".join(owners)
                    + " (indexes are burned into devices; each must be unique)"
                )

    return errors


def duplicate_index_messages(errors: list[str]) -> tuple[list[str], list[str]]:
    dups: list[str] = []
    other: list[str] = []
    for err in errors:
        if "is used by multiple ids" in err:
            dups.append(err)
        else:
            other.append(err)
    return dups, other


def mapping_from_presets(presets: dict[str, Any]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {s: {} for s in SECTIONS}
    for section in SECTIONS:
        for item in presets.get(section, []):
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or "index" not in item:
                continue
            if not is_positive_int(item["index"]):
                continue
            out[section][item_id] = as_int(item["index"])
    return out


def mapping_from_registry(registry: dict[str, Any]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {s: {} for s in SECTIONS}
    for section in SECTIONS:
        block = registry.get(section)
        if not isinstance(block, dict):
            continue
        for item_id, index in block.items():
            if item_id.startswith("_"):
                continue
            if not is_positive_int(index):
                continue
            out[section][str(item_id)] = as_int(index)
    return out


def validate_against_registry(
    preset_map: dict[str, dict[str, int]],
    registry_map: dict[str, dict[str, int]],
) -> list[str]:
    errors: list[str] = []
    for section in SECTIONS:
        label = SECTION_LABEL[section]
        presets = preset_map[section]
        registry = registry_map[section]

        registry_by_index: dict[int, list[str]] = defaultdict(list)
        for reg_id, index in registry.items():
            registry_by_index[index].append(reg_id)

        for item_id, index in presets.items():
            if item_id not in registry:
                owners = registry_by_index.get(index, [])
                if owners:
                    errors.append(
                        f"{label} id {item_id!r} reuses reserved index {index} "
                        f"(owned by registry id(s): {', '.join(owners)}); "
                        f"pick the next free index and register it"
                    )
                else:
                    errors.append(
                        f"{label} id {item_id!r} (index {index}) is missing from "
                        f"simple-config-id-registry.json — add it when introducing a new preset"
                    )
            elif registry[item_id] != index:
                errors.append(
                    f"{label} id {item_id!r} reassigned: presets index={index}, "
                    f"registry index={registry[item_id]} "
                    f"(do not change indexes; add a new id instead)"
                )

    return errors


def validate_registry_append_only(
    current: dict[str, dict[str, int]],
    base: dict[str, dict[str, int]],
) -> list[str]:
    """Registry mappings may only grow; existing id→index pairs are immutable."""
    errors: list[str] = []
    for section in SECTIONS:
        label = SECTION_LABEL[section]
        cur = current[section]
        old = base[section]

        for item_id, old_index in old.items():
            if item_id not in cur:
                errors.append(
                    f"registry {label} id {item_id!r} was removed "
                    f"(index {old_index} must stay reserved forever)"
                )
            elif cur[item_id] != old_index:
                errors.append(
                    f"registry {label} id {item_id!r} changed "
                    f"{old_index} → {cur[item_id]} (reassignment forbidden)"
                )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="Repository root (default: auto-detect from script location)",
    )
    parser.add_argument(
        "--base-registry",
        type=Path,
        default=None,
        help="Previous registry JSON to enforce append-only (e.g. from origin/main)",
    )
    parser.add_argument(
        "--strict-unique-indexes",
        action="store_true",
        help="Fail on duplicate indexes within a section (default: warn; legacy collisions exist)",
    )
    args = parser.parse_args()

    script_path = Path(__file__).resolve()
    repo_root = args.repo_root or script_path.parents[2]
    toolbox = repo_root / "httpdocs" / "firmware" / "toolbox"
    presets_path = toolbox / "simple-config-presets.json"
    registry_path = toolbox / "simple-config-id-registry.json"

    errors: list[str] = []
    warnings: list[str] = []

    if not presets_path.is_file():
        print(f"error: missing {presets_path}", file=sys.stderr)
        return 2
    if not registry_path.is_file():
        print(f"error: missing {registry_path}", file=sys.stderr)
        return 2

    try:
        presets = load_json(presets_path)
        registry = load_json(registry_path)
    except json.JSONDecodeError as e:
        print(f"error: invalid JSON: {e}", file=sys.stderr)
        return 2

    if not isinstance(presets, dict) or not isinstance(registry, dict):
        print("error: presets and registry must be JSON objects", file=sys.stderr)
        return 2

    for section in SECTIONS:
        if section not in registry or not isinstance(registry[section], dict):
            errors.append(f"registry missing object key '{section}'")

    struct_errors = validate_structure(presets, toolbox)
    dup_msgs, other_struct = duplicate_index_messages(struct_errors)
    if args.strict_unique_indexes:
        errors.extend(dup_msgs)
    else:
        warnings.extend(dup_msgs)
    errors.extend(other_struct)

    preset_map = mapping_from_presets(presets)
    registry_map = mapping_from_registry(registry)
    errors.extend(validate_against_registry(preset_map, registry_map))

    if args.base_registry is not None:
        if not args.base_registry.is_file():
            # First introduction of the registry on a branch with no base file yet.
            warnings.append(
                f"base registry not found at {args.base_registry}; "
                "skipping append-only check"
            )
        else:
            try:
                base_registry = load_json(args.base_registry)
            except json.JSONDecodeError as e:
                errors.append(f"base registry invalid JSON: {e}")
            else:
                if isinstance(base_registry, dict):
                    errors.extend(
                        validate_registry_append_only(
                            registry_map, mapping_from_registry(base_registry)
                        )
                    )
                else:
                    errors.append("base registry must be a JSON object")

    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")

    if errors:
        print(
            f"\nsimple-config validation failed with {len(errors)} error(s).",
            file=sys.stderr,
        )
        return 1

    total = sum(len(preset_map[s]) for s in SECTIONS)
    print(
        f"simple-config OK: {total} presets; "
        f"id/index registry stable"
        + (f"; {len(warnings)} warning(s)" if warnings else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
