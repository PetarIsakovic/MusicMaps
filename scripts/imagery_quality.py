"""Conservative missing-data screening for natural-color satellite thumbnails.

This is a selection gate, not an image repair operation: accepted pixels are
never modified. Brightness alone is not a defect. Missing-data detection needs
both an almost-white/black, locally flat area and substantial extent. Textured
snow, pale desert, and dark water can therefore remain useful palette entries.
"""

import numpy as np
from PIL import Image


QUALITY_VERSION = 2
ANALYSIS_SIZE = 128


def is_bright_neutral(mean_rgb):
    """Return whether an accepted tile is useful for pale neutral video."""
    red, green, blue = mean_rgb
    luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
    spread = max(mean_rgb) - min(mean_rgb)
    return luma >= 200 and spread <= 25


def _white_geometry(mask):
    """Measure connected white areas using compact horizontal runs.

    A rectangular no-data slab has a tightly filled bounding box. Natural snow
    winds between mountain ridges and has much less rectangular components.
    Run-length components avoid a Python visit for every white pixel.
    """
    height, width = mask.shape
    parents, runs, previous = [], [], []

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for y, row in enumerate(mask):
        changes = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        current = []
        for start, end in zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1)):
            start, end = int(start), int(end)
            index = len(parents)
            parents.append(index)
            runs.append((start, end, y))
            current.append((start, end, index))
            for old_start, old_end, old_index in previous:
                if old_end <= start:
                    continue
                if old_start >= end:
                    break
                parents[root(old_index)] = root(index)
        previous = current
    components = {}
    for index, (start, end, y) in enumerate(runs):
        key = root(index)
        if key not in components:
            components[key] = [0, start, end, y, y + 1]
        component = components[key]
        component[0] += end - start
        component[1] = min(component[1], start)
        component[2] = max(component[2], end)
        component[3] = min(component[3], y)
        component[4] = max(component[4], y + 1)
    area = height * width
    largest_area, largest_fill, rectangular_area = 0, 0.0, 0
    for count, left, right, top, bottom in components.values():
        fill = count / ((right - left) * (bottom - top))
        if count > largest_area:
            largest_area, largest_fill = count, fill
        if fill >= 0.90 and count / area >= 0.015:
            rectangular_area = max(rectangular_area, count)
    return largest_area / area, largest_fill, max(rectangular_area / area,
                                                _supported_white_rectangle(mask))


def _supported_white_rectangle(mask):
    """Find filled rectangles with straight, contrasting outside boundaries.

    A synthetic hole can join surrounding natural snow, making its connected
    component irregular. Maximal filled rectangles still expose its straight
    boundaries. Inscribed rectangles inside irregular snow lack this support.
    """
    height, width = mask.shape
    integral = np.pad(mask.astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    histogram = np.zeros(width, dtype=np.int16)
    largest = 0.0

    def nonwhite(left, top, right, bottom):
        if left < 0 or top < 0 or right > width or bottom > height:
            return 1.0
        total = (integral[bottom, right] - integral[top, right]
                 - integral[bottom, left] + integral[top, left])
        return 1 - float(total) / ((right - left) * (bottom - top))

    for y, row in enumerate(mask):
        histogram = np.where(row, histogram + 1, 0)
        stack = []
        for x in range(width + 1):
            current = int(histogram[x]) if x < width else 0
            start = x
            while stack and stack[-1][1] > current:
                left, depth = stack.pop()
                start = left
                fraction = depth * (x - left) / (width * height)
                if depth < 3 or x - left < 3 or fraction < 0.02:
                    continue
                top, bottom = y - depth + 1, y + 1
                edges = [nonwhite(left, top - 1, x, top),
                         nonwhite(left, bottom, x, bottom + 1),
                         nonwhite(left - 1, top, left, bottom),
                         nonwhite(x, top, x + 1, bottom)]
                if ((min(edges[:2]) >= 0.60 and max(edges[2:]) >= 0.4)
                        or (min(edges[2:]) >= 0.60 and max(edges[:2]) >= 0.4)):
                    largest = max(largest, fraction)
            if current and (not stack or stack[-1][1] < current):
                stack.append((start, current))
    return largest


def _snow_texture(rgb):
    """Count spatially distributed detail, not just a detailed image corner."""
    textured = 0
    for row in np.array_split(rgb, 4, axis=0):
        for cell in np.array_split(row, 4, axis=1):
            if min(cell.shape[:2]) < 2:
                continue
            gradient = (np.abs(np.diff(cell, axis=0)).mean()
                        + np.abs(np.diff(cell, axis=1)).mean()) / 2
            if gradient >= 2 and float((cell.min(axis=2) < 240).mean()) >= 0.03:
                textured += 1
    return textured


def _longest_run(mask):
    """Longest contiguous horizontal or vertical run, as a side fraction."""
    longest = 0.0
    for rows in (mask, mask.T):
        indices = np.arange(1, rows.shape[1] + 1, dtype=np.int16)[None, :]
        last_false = np.maximum.accumulate(np.where(rows, 0, indices), axis=1)
        lengths = np.where(rows, indices - last_false, 0)
        longest = max(longest, float(lengths.max()) / rows.shape[1])
    return longest


def analyze_quality(image):
    """Return JSON-safe acceptance, reason codes, and numeric quality metrics.

    Input may be any PIL image mode/size; normal RGB map tiles are expected.
    Work is capped at 128 pixels per side for repeatable, inexpensive screening.
    Reason codes include ``featureless_image``, ``white_missing_data``,
    ``black_missing_data``, ``insufficient_snow_detail``, and
    ``snow_color_artifacts``. Metric fractions are
    in [0, 1], while standard
    deviation and neighboring-pixel differences use 8-bit channel units.
    """
    rgb_image = image.convert('RGB')
    if max(rgb_image.size) > ANALYSIS_SIZE:
        rgb_image.thumbnail((ANALYSIS_SIZE, ANALYSIS_SIZE), Image.Resampling.BOX)
    rgb = np.asarray(rgb_image, dtype=np.int16)
    height, width = rgb.shape[:2]
    # The 3x3 channel range detects flat fill while avoiding a brightness-only
    # snow/cloud test. Edge padding lets a slab touching the image edge count.
    padded = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode='edge')
    local_min = rgb.copy()
    local_max = rgb.copy()
    for dy in range(3):
        for dx in range(3):
            neighbor = padded[dy:dy + height, dx:dx + width]
            np.minimum(local_min, neighbor, out=local_min)
            np.maximum(local_max, neighbor, out=local_max)
    flat = (local_max - local_min).max(axis=2) <= 2
    white = (rgb.min(axis=2) >= 250) & (np.ptp(rgb, axis=2) <= 3)
    black = rgb.max(axis=2) <= 4
    flat_white, flat_black = flat & white, flat & black
    white_fraction = float(flat_white.mean())
    black_fraction = float(flat_black.mean())
    white_run, black_run = _longest_run(flat_white), _longest_run(flat_black)
    stddev = float(rgb.reshape(-1, 3).std(axis=0).max())
    gradients = []
    if width > 1:
        gradients.append(float(np.abs(np.diff(rgb, axis=1)).mean()))
    if height > 1:
        gradients.append(float(np.abs(np.diff(rgb, axis=0)).mean()))
    gradient = sum(gradients) / len(gradients) if gradients else 0.0

    white_defect = white_fraction >= 0.08 or (white_fraction >= 0.02 and white_run >= 0.18)
    snow_exception = False
    snow_cells, component_area, component_fill, rectangular_area = 0, 0.0, 0.0, 0.0
    magenta_fraction, yellow_fraction = 0.0, 0.0
    if white_defect:
        component_area, component_fill, rectangular_area = _white_geometry(white)
        snow_cells = _snow_texture(rgb)
        red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        magenta_fraction = float(((red >= 180) & (blue >= 180)
                                  & (green <= np.minimum(red, blue) - 45)).mean())
        yellow_fraction = float(((red >= 225) & (green >= 225) & (blue < 150)).mean())
        # Clipped snow is acceptable only when mountain/glacier detail is spread
        # through the photograph. This never admits rectangular slabs, mostly
        # empty ice caps, or the neon color artifacts found in polar mosaics.
        mean = rgb.reshape(-1, 3).mean(axis=0)
        # Palette brightness is a separate concern. Moderately dark mountain
        # ridges can coexist with valid snow in the same photograph.
        neutral_snow = (float(mean @ np.array([0.2126, 0.7152, 0.0722])) >= 150
                        and float(np.ptp(mean)) <= 35)
        snow_exception = (neutral_snow and snow_cells >= 13
                          and component_fill <= 0.70 and rectangular_area == 0
                          and magenta_fraction <= 0.0001 and yellow_fraction <= 0.001)

    reasons = []
    if stddev < 1.0 and gradient < 0.65:
        reasons.append('featureless_image')
    # A long thin strip can spoil an otherwise detailed photo; global variance
    # misses it. Also reject large disconnected fill areas without long runs.
    if white_defect and not snow_exception:
        if rectangular_area > 0 or component_fill >= 0.90:
            reasons.append('white_missing_data')
        else:
            reasons.append('insufficient_snow_detail')
    if white_defect and (magenta_fraction > 0.0001 or yellow_fraction > 0.001):
        reasons.append('snow_color_artifacts')
    if black_fraction >= 0.08 or (black_fraction >= 0.02 and black_run >= 0.18):
        reasons.append('black_missing_data')
    return {
        'version': QUALITY_VERSION,
        'accepted': not reasons,
        'reasons': reasons,
        'metrics': {
            'analysisWidth': width,
            'analysisHeight': height,
            'channelStddevMax': round(stddev, 6),
            'meanNeighborDifference': round(gradient, 6),
            'nearWhiteFraction': round(float(white.mean()), 6),
            'nearBlackFraction': round(float(black.mean()), 6),
            'flatWhiteFraction': round(white_fraction, 6),
            'flatBlackFraction': round(black_fraction, 6),
            'longestFlatWhiteRun': round(white_run, 6),
            'longestFlatBlackRun': round(black_run, 6),
            'texturedSnowCells': snow_cells,
            'largestWhiteComponentFraction': round(component_area, 6),
            'largestWhiteComponentBoxFill': round(component_fill, 6),
            'rectangularWhiteFraction': round(rectangular_area, 6),
            'snowMagentaFraction': round(magenta_fraction, 6),
            'snowYellowFraction': round(yellow_fraction, 6),
            'distributedSnowAccepted': int(snow_exception),
        },
    }
