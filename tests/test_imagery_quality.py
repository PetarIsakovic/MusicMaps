"""Run: .cache/imagery-venv/bin/python -m unittest discover -s tests -p test_imagery_quality.py"""

import importlib.util
from io import BytesIO
import json
from pathlib import Path
import unittest

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('imagery_quality', ROOT / 'scripts/imagery_quality.py')
QUALITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUALITY)


def textured(base=(90, 110, 80), variation=12, seed=42):
    noise = np.random.default_rng(seed).normal(0, variation, (256, 256, 1))
    return np.clip(np.array(base)[None, None, :] + noise, 0, 255).astype(np.uint8)


class ImageryQualityTests(unittest.TestCase):
    def test_bright_neutral_palette_excludes_warm_desert(self):
        self.assertTrue(QUALITY.is_bright_neutral((245, 245, 245)))
        self.assertTrue(QUALITY.is_bright_neutral((225, 230, 235)))
        self.assertFalse(QUALITY.is_bright_neutral((185, 190, 200)))
        self.assertFalse(QUALITY.is_bright_neutral((140, 140, 140)))
        self.assertFalse(QUALITY.is_bright_neutral((220, 220, 190)))
        self.assertFalse(QUALITY.is_bright_neutral((238, 218, 175)))
        self.assertFalse(QUALITY.is_bright_neutral((210, 190, 120)))

    def analyze(self, pixels):
        result = QUALITY.analyze_quality(Image.fromarray(pixels))
        # Callers store these results in a manifest, so NumPy scalars cannot leak.
        self.assertEqual(json.loads(json.dumps(result)), result)
        return result

    def test_rejects_partial_white_strip_even_with_detailed_terrain(self):
        pixels = textured()
        pixels[:90] = 255
        pixels[160:] = 255
        result = self.analyze(pixels)
        self.assertFalse(result['accepted'])
        self.assertIn('white_missing_data', result['reasons'])
        self.assertGreater(result['metrics']['channelStddevMax'], 40)

    def test_rejects_thin_white_or_black_slabs_and_interior_holes(self):
        for color in (0, 255):
            for area in ((slice(None), slice(0, 12)),
                         (slice(96, 152), slice(96, 152))):
                with self.subTest(color=color, area=area):
                    pixels = textured()
                    pixels[area] = color
                    result = self.analyze(pixels)
                    self.assertFalse(result['accepted'])
                    self.assertIn(('white' if color else 'black') + '_missing_data', result['reasons'])

    def test_rejects_jpeg_compressed_missing_data(self):
        pixels = textured()
        pixels[:, :80] = 253
        stream = BytesIO()
        Image.fromarray(pixels).save(stream, format='JPEG', quality=85)
        stream.seek(0)
        result = QUALITY.analyze_quality(Image.open(stream))
        self.assertFalse(result['accepted'])
        self.assertIn('white_missing_data', result['reasons'])

    def test_rejects_featureless_blank_images_at_any_brightness(self):
        for color in ((255, 255, 255), (0, 0, 0), (128, 128, 128), (5, 20, 40)):
            with self.subTest(color=color):
                result = self.analyze(np.full((256, 256, 3), color, dtype=np.uint8))
                self.assertFalse(result['accepted'])
                self.assertIn('featureless_image', result['reasons'])

    def test_retains_textured_snow_desert_water_and_terrain(self):
        for name, base, variation in [('snow', (249, 249, 249), 13),
                                       ('desert', (238, 218, 175), 8),
                                       ('water', (8, 25, 42), 4),
                                       ('terrain', (90, 110, 80), 12)]:
            with self.subTest(name=name):
                result = self.analyze(textured(base, variation))
                self.assertTrue(result['accepted'], result)

    def test_retains_isolated_bright_highlights(self):
        pixels = textured((240, 242, 244), 18)
        pixels[::8, ::8] = 255
        result = self.analyze(pixels)
        self.assertTrue(result['accepted'], result)

    def test_screenshot_regression(self):
        path = ROOT / 'tests/data/imagery-missing-coverage.webp'
        with Image.open(path) as image:
            result = QUALITY.analyze_quality(image)
        self.assertFalse(result['accepted'])
        self.assertIn('white_missing_data', result['reasons'])
        self.assertGreater(result['metrics']['flatWhiteFraction'], 0.65)

    def test_same_location_in_2025_has_good_coverage(self):
        path = ROOT / 'tests/data/imagery-2025-coverage.png'
        with Image.open(path) as image:
            result = QUALITY.analyze_quality(image)
        self.assertTrue(result['accepted'], result)

    def test_real_distributed_snow_retains_mountain_detail(self):
        for name in ['snow-st-elias-57-146', 'snow-st-elias-58-147',
                     'snow-st-elias-58-148', 'snow-bagley-55-147',
                     'snow-st-elias-57-147', 'snow-st-elias-56-147']:
            with self.subTest(fixture=name):
                with Image.open(ROOT / 'tests/data' / (name + '.webp')) as image:
                    result = QUALITY.analyze_quality(image)
                self.assertTrue(result['accepted'], result)
                self.assertEqual(result['metrics']['distributedSnowAccepted'], 1)
                self.assertGreaterEqual(result['metrics']['texturedSnowCells'], 13)

    def test_rejects_real_clipped_ice_caps_and_color_artifacts(self):
        for name in ['snow-clipped-vatnajokull', 'snow-clipped-devon',
                     'snow-artifacts-svalbard', 'snow-artifacts-subtle-svalbard']:
            with self.subTest(fixture=name):
                with Image.open(ROOT / 'tests/data' / (name + '.webp')) as image:
                    result = QUALITY.analyze_quality(image)
                self.assertFalse(result['accepted'], result)
                if 'artifacts' in name:
                    self.assertIn('snow_color_artifacts', result['reasons'])
                else:
                    self.assertIn('white_missing_data', result['reasons'])

    def test_snow_exception_does_not_admit_added_slabs_or_holes(self):
        with Image.open(ROOT / 'tests/data/snow-st-elias-58-147.webp') as image:
            original = np.array(image.convert('RGB'))
        for area in [(slice(None), slice(0, 20)),
                     (slice(92, 164), slice(92, 164))]:
            with self.subTest(area=area):
                pixels = original.copy()
                pixels[area] = 255
                result = self.analyze(pixels)
                self.assertFalse(result['accepted'], result)
                self.assertIn('white_missing_data', result['reasons'])


if __name__ == '__main__':
    unittest.main()
