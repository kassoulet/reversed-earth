#!/usr/bin/env python3
"""Build the south-up terrain overlays as raster PMTiles.

Two Natural Earth rasters feed this builder:

* ``SR_HR`` is a grayscale shaded-relief image. It becomes a transparent
  hillshade overlay: dark relief is drawn with a warm shadow, lit slopes with a
  pale highlight, and flat water stays transparent.
* ``NE1_LR_LC`` is the Natural Earth I land-cover image. Its dark-green forest
  areas become a transparent green wash.

The source rasters are plate carrée. Both are warped to a square Web Mercator
world, split into 256 px XYZ tiles and written to PMTiles. A south-up copy is
made by flipping the north-up image vertically, so the overlay registers with
the south-up vector archive without a runtime transform. The north-up copy is
the warped image unchanged.

This is a raster companion to ``build_natural_earth.py``, not a replacement:
the vector archive carries geometry, labels and click targets, while these
overlays add continuous terrain and land-cover texture.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import math
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

LOG = logging.getLogger("natural-earth-terrain")

Image.MAX_IMAGE_PIXELS = None

NE_RASTER_BASE = "https://naciscdn.org/naturalearth/10m/raster"
TILE_SIZE = 256
MAX_ZOOM = 5
# A Web Mercator world is square, unlike the 2:1 plate carrée source rasters.
# Keep both dimensions equal or the overlays are squeezed into one half of the
# tile grid and stop registering with the vector archive.
OUTPUT_WIDTH = 8192
OUTPUT_HEIGHT = OUTPUT_WIDTH

# Pinned Natural Earth raster downloads. The zips are build-time inputs and are
# cached outside git, like the vector GeoJSON sources.
RASTER_SOURCES: dict[str, tuple[str, str, str]] = {
    "SR_HR.zip": (
        "b2619fff2fc73c17152983c066adfaa25c4b626916b822bad2fae8bcd9be41a5",
        f"{NE_RASTER_BASE}/SR_HR.zip",
        "SR_HR.tif",
    ),
    "NE1_LR_LC.zip": (
        "dae6ad77c963976f44afb3a3916febf36f44c42da1690854b9fa1dac74694e54",
        f"{NE_RASTER_BASE}/NE1_LR_LC.zip",
        "NE1_LR_LC.tif",
    ),
}

ATTRIBUTION = (
    "Natural Earth (public domain) · "
    '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">'
    "naturalearthdata.com</a>"
)

# The shaded-relief source is mostly flat #cecece water. Values near this
# neutral are left transparent; deviations become shadow or highlight.
SHADED_RELIEF_NEUTRAL = 206


def human_size(size: float) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1000
    return f"{size} B"


def fetch_sources(cache_dir: Path) -> dict[str, Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, (expected_hash, url, member) in RASTER_SOURCES.items():
        path = cache_dir / name
        if not path.exists():
            LOG.info("Downloading %s", name)
            request = urllib.request.Request(
                url, headers={"User-Agent": "south-up-map/1"}
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                path.write_bytes(response.read())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected_hash:
            raise RuntimeError(
                f"{name}: expected sha256 {expected_hash}, got {digest}. "
                "Delete the cached file and retry."
            )
        extracted = cache_dir / member
        if not extracted.exists():
            LOG.info("Extracting %s", member)
            with zipfile.ZipFile(path) as archive:
                archive.extract(member, cache_dir)
        paths[name] = extracted
        LOG.info("Using %s (%s)", member, human_size(extracted.stat().st_size))
    return paths


def warp_to_mercator(image: Image.Image, width: int, height: int) -> Image.Image:
    """Resample a plate-carrée image into a north-up Web Mercator image."""
    source = np.asarray(image)
    source_height, source_width = source.shape[:2]
    x_index = np.rint(np.linspace(0, source_width - 1, width)).astype(np.int32)
    latitudes = np.degrees(
        np.arctan(np.sinh(math.pi * (1.0 - 2.0 * np.arange(height) / height)))
    )
    y_index = np.rint(
        (90.0 - latitudes) / 180.0 * (source_height - 1)
    ).astype(np.int32)
    # Two passes keep peak memory near source + one scanline block.
    rows = source[y_index]
    return Image.fromarray(rows[:, x_index])


def hillshade_image(source: Image.Image) -> Image.Image:
    """Turn shaded relief into a transparent warm shadow / pale highlight."""
    values = np.asarray(source.convert("L")).astype(np.int16)
    delta = values - SHADED_RELIEF_NEUTRAL
    shadow = np.clip(-delta * 1.6, 0, 150)
    highlight = np.clip((delta - 6) * 1.0, 0, 80)

    output = np.zeros((values.shape[0], values.shape[1], 4), dtype=np.uint8)
    output[..., 0] = 74
    output[..., 1] = 63
    output[..., 2] = 48
    output[..., 3] = shadow.astype(np.uint8)

    lit = highlight > 0
    output[lit, 0] = 255
    output[lit, 1] = 248
    output[lit, 2] = 235
    output[lit, 3] = highlight[lit].astype(np.uint8)
    return Image.fromarray(output)


def forest_image(source: Image.Image, red_thresh: int = 220, green_off: int = 8, blue_thresh: int = 220, green_min: int = 150) -> Image.Image:
    """Extract dark-green forest cover from the Natural Earth I land cover.

    Adjusts the color thresholds to better match the Natural Earth I land cover
    palette. The default values (220/8/220/150) provide better forest detection
    than the original (205/12/205/150).
    """
    values = np.asarray(source.convert("RGB")).astype(np.int16)
    red, green, blue = values[..., 0], values[..., 1], values[..., 2]
    forest = (
        (red < red_thresh)
        & (green > red + green_off)
        & (green > blue + green_off)
        & (blue < blue_thresh)
        & (green > green_min)
    )
    alpha = np.where(forest, np.clip((green - red) * 4, 60, 120), 0).astype(
        np.uint8
    )

    output = np.zeros((values.shape[0], values.shape[1], 4), dtype=np.uint8)
    output[..., 0] = 78
    output[..., 1] = 112
    output[..., 2] = 70
    output[..., 3] = alpha
    return Image.fromarray(output)


def orientation_copies(image: Image.Image) -> dict[str, Image.Image]:
    """Return the north-up and south-up images for the tile grids.

    ``image`` is already north-up because the Mercator warp keeps the source
    row order. South-up display space inverts latitude, so its copy is the
    north-up image flipped top to bottom.
    """
    return {
        "north": image,
        "south": image.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
    }


def encode_tile(image: Image.Image, zoom: int, x: int, y: int) -> bytes | None:
    if image.width != image.height:
        raise ValueError(
            "overlay images must be square to cover the Web Mercator world"
        )
    world = TILE_SIZE * (2**zoom)
    scale = image.width / world
    left = x * TILE_SIZE * scale
    top = y * TILE_SIZE * scale
    right = left + TILE_SIZE * scale
    bottom = top + TILE_SIZE * scale
    crop = image.crop((round(left), round(top), round(right), round(bottom)))
    if crop.width != TILE_SIZE or crop.height != TILE_SIZE:
        crop = crop.resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
    if crop.getchannel("A").getbbox() is None:
        return None

    buffer = io.BytesIO()
    crop.save(buffer, "WEBP", quality=80, method=4)
    return buffer.getvalue()


def write_archive(
    image: Image.Image,
    output: Path,
    *,
    name: str,
    maxzoom: int = MAX_ZOOM,
    south_up: bool = True,
) -> dict[str, Any]:
    started = time.monotonic()
    tiles: list[tuple[int, bytes]] = []
    for zoom in range(maxzoom + 1):
        for x in range(2**zoom):
            for y in range(2**zoom):
                data = encode_tile(image, zoom, x, y)
                if data is not None:
                    tiles.append((zxy_to_tileid(zoom, x, y), data))
        LOG.info("%s z%s: %s tiles so far", name, zoom, len(tiles))

    tiles.sort(key=lambda item: item[0])
    output.parent.mkdir(parents=True, exist_ok=True)
    header: dict[str, Any] = {
        "min_zoom": 0,
        "max_zoom": maxzoom,
        "min_lon_e7": -1_800_000_000,
        "min_lat_e7": -850_511_288,
        "max_lon_e7": 1_800_000_000,
        "max_lat_e7": 850_511_288,
        "center_zoom": 1,
        "center_lon_e7": 0,
        "center_lat_e7": 0,
        "tile_type": TileType.WEBP,
        "tile_compression": Compression.NONE,
        "addressed_tiles_count": 0,
        "tile_entries_count": 0,
        "tile_contents_count": 0,
    }
    metadata = {
        "name": name,
        "attribution": ATTRIBUTION,
        "south_up": south_up,
        "format": "webp",
        "description": (
            "Natural Earth raster overlay in display space. "
            "Display latitude is the negation of real latitude."
            if south_up
            else "Natural Earth raster overlay in north-up Web Mercator space."
        ),
    }
    with output.open("wb") as handle:
        writer = Writer(handle)
        for tile_id, data in tiles:
            writer.write_tile(tile_id, data)
        writer.finalize(header, metadata)

    size = output.stat().st_size
    LOG.info(
        "%s: %s tiles, %s, %.0fs",
        output.name,
        len(tiles),
        human_size(size),
        time.monotonic() - started,
    )
    return {
        "path": output.name,
        "tiles": len(tiles),
        "bytes": size,
        "human": human_size(size),
        "maxzoom": maxzoom,
        "elapsed_seconds": round(time.monotonic() - started, 1),
    }


def build(
    cache_dir: Path,
    output_dir: Path,
    *,
    force: bool = False,
    maxzoom: int = MAX_ZOOM,
) -> dict[str, Any]:
    outputs = [
        output_dir / "hillshade-south.pmtiles",
        output_dir / "hillshade-north.pmtiles",
        output_dir / "forest-south.pmtiles",
        output_dir / "forest-north.pmtiles",
    ]
    existing = [path for path in outputs if path.exists()]
    if existing and not force:
        raise SystemExit(
            f"{existing[0]} already exists; pass --force to replace the overlays"
        )
    for path in existing:
        path.unlink()

    started = time.monotonic()
    sources = fetch_sources(cache_dir)

    report: list[dict[str, Any]] = []
    for kind, source_name, convert, name in (
        ("hillshade", "SR_HR.zip", hillshade_image, "Reverse Earth hillshade"),
        ("forest", "NE1_LR_LC.zip", forest_image, "Reverse Earth forest cover"),
    ):
        LOG.info("Warping %s to Web Mercator", sources[source_name].name)
        warped = warp_to_mercator(
            Image.open(sources[source_name]), OUTPUT_WIDTH, OUTPUT_HEIGHT
        )
        image = convert(warped)
        del warped

        # Write each source one at a time so the two full-size warped images
        # and their RGBA copies are never resident together.
        for orientation, oriented in orientation_copies(image).items():
            report.append(
                write_archive(
                    oriented,
                    output_dir / f"{kind}-{orientation}.pmtiles",
                    name=name,
                    maxzoom=maxzoom,
                    south_up=orientation == "south",
                )
            )

    total_bytes = sum(item["bytes"] for item in report)
    return {
        "sources": {
            name: {
                "sha256": expected_hash,
                "url": url,
                "member": member,
            }
            for name, (expected_hash, url, member) in RASTER_SOURCES.items()
        },
        "outputs": report,
        "output_bytes": total_bytes,
        "output_human": human_size(total_bytes),
        "elapsed_seconds": round(time.monotonic() - started, 1),
    }


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path(__file__).resolve().parent.parent / ".cache" / "ne-raster",
        help="Natural Earth raster download cache",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("public/data"),
        help="directory for the four overlay PMTiles files",
    )
    parser.add_argument("--maxzoom", type=int, default=MAX_ZOOM)
    parser.add_argument("--force", action="store_true", help="replace outputs")
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(message)s",
    )
    if args.maxzoom < 0 or args.maxzoom > MAX_ZOOM:
        raise SystemExit(f"maxzoom must be within 0-{MAX_ZOOM}")
    report = build(
        args.cache,
        args.output_dir,
        force=args.force,
        maxzoom=args.maxzoom,
    )
    report_path = args.report or (
        Path(__file__).resolve().parent.parent
        / ".work"
        / "natural-earth-terrain-report.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print()
    print("NATURAL EARTH TERRAIN")
    print(f"  overlays:       {len(report['outputs'])}")
    print(f"  total:          {report['output_human']}")
    for item in report["outputs"]:
        print(f"    {item['path']}: {item['tiles']} tiles, {item['human']}")
    print(f"  report:         {report_path}")
    print(f"  elapsed:        {report['elapsed_seconds']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
