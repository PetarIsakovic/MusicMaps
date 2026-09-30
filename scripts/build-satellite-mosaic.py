#!/usr/bin/env python3
"""Compatibility entry point for the wide-scene satellite library builder.

Requires Pillow. Rebuilds the pinned, naturally colored scene library and its
matching tables. Pass --discover to refresh its globally distributed sources.
"""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("build-satellite-scenes.py")), run_name="__main__")
